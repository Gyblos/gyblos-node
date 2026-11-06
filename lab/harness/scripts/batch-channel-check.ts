// Lab check of one long-lived x402 batch-settlement channel on Solana: the buyer deposits once, pays
// several requests with server-signed metered vouchers, the seller redeems them in one batch and the
// buyer gets the unused escrow back. Official SDK pieces only (client, server, facilitator) against the
// payment-channels program at CHNL…. By default it runs on a loopback validator that loads the program
// dumped from devnet, with throwaway keys. With --devnet (founder-approved runs only) it uses the public
// devnet RPC, checks the genesis hash, and keeps its keys in the lab home so leftover SOL is not lost;
// only the funder key needs devnet SOL. A fresh test mint either way, never USDC.
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import {
  getCreateAccountInstruction,
  getTransferSolInstruction,
} from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintToInstruction,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';
import type { FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/express';
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from '@x402/fetch';
import { toFacilitatorSvmSigner } from '@x402/svm';
import { BatchSvmScheme as BatchClient } from '@x402/svm/batch-settlement/client';
import {
  BatchSvmScheme as BatchFacilitator,
  InMemoryBatchChannelStorage,
} from '@x402/svm/batch-settlement/facilitator';
import {
  BatchSvmScheme as BatchServer,
  MemoryChannelStore,
} from '@x402/svm/batch-settlement/server';
import express from 'express';

import {
  DEVNET,
  DEVNET_RPC_URL,
  DEVNET_TREASURY_OWNER,
  FILE_MODES,
  labLayout,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config';

const ON_DEVNET = process.argv.includes('--devnet');
const RPC_URL = ON_DEVNET
  ? DEVNET_RPC_URL
  : (process.env.CHECK_RPC_URL ?? 'http://127.0.0.1:8899');
// The first 32 characters of devnet's genesis hash, as in its CAIP-2 id.
const DEVNET_GENESIS_PREFIX = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const ROLES = [
  'funder',
  'facilitator',
  'buyer',
  'payTo',
  'receiverAuthorizer',
  'operator',
] as const;
// On devnet the funder pays the mint and token accounts and tops up the facilitator, which pays
// every channel transaction; the buyer needs no SOL.
const FUNDER_MINIMUM = 50_000_000n;
const FACILITATOR_MINIMUM = 10_000_000n;
const FACILITATOR_TOP_UP = 20_000_000n;
const DECIMALS = 6;
const BUYER_TOKENS = 100_000n;
const DEPOSIT = 10_000n;
// Ceiling per request; the operator signs the metered charge after serving.
const REQUEST_CEILING = 1_000n;
const METERED = [145n, 210n, 95n];
// The SDK accepts 900 s to 30 days; a cooperative refund does not wait for it.
const WITHDRAW_DELAY_SECONDS = 900;
const MINT_SPACE = 82n;
const AIRDROP_LAMPORTS = 2_000_000_000;
const DEVNET_AIRDROP_LAMPORTS = 1_000_000_000;
const CONFIRM_ATTEMPTS = 120;
const CONFIRM_POLL_MS = 1_000;

// The public devnet RPC answers 429 under bursts; on devnet every request (the SDK's included) is
// spaced out and a 429 is retried after a pause.
const DEVNET_SPACING_MS = 250;
const DEVNET_RETRIES = 8;
const DEVNET_BACKOFF_MS = 2_000;
const TOO_MANY_REQUESTS = 429;
if (ON_DEVNET) {
  const plainFetch = globalThis.fetch;
  let last = 0;
  globalThis.fetch = async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + DEVNET_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
      const response = await plainFetch(input, init);
      if (response.status !== TOO_MANY_REQUESTS || attempt >= DEVNET_RETRIES)
        return response;
      await new Promise((resolve) =>
        setTimeout(resolve, DEVNET_BACKOFF_MS * (attempt + 1)),
      );
    }
  };
}

if (!ON_DEVNET && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC_URL))
  throw new Error(
    'without --devnet, batch-channel-check runs only against a loopback validator',
  );

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error !== undefined)
    throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

async function confirm(signature: string) {
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
    const { value } = await rpc<{
      value: ({ confirmationStatus?: string; err: unknown } | null)[];
    }>('getSignatureStatuses', [[signature]]);
    const status = value[0];
    if (status?.err)
      throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
  }
  throw new Error(`not confirmed: ${signature}`);
}

async function send(feePayer: KeyPairSigner, instructions: Instruction[]) {
  const { value: latest } = await rpc<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(feePayer, draft),
    (draft) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: latest.blockhash as never,
          lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        },
        draft,
      ),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = await rpc<string>('sendTransaction', [
    getBase64EncodedWireTransaction(signed),
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  await confirm(signature);
}

async function airdrop(to: Address, lamports = AIRDROP_LAMPORTS) {
  await confirm(await rpc<string>('requestAirdrop', [to, lamports]));
}

type Role = (typeof ROLES)[number];

async function signersByRole(make: (role: Role) => Promise<KeyPairSigner>) {
  const entries = await Promise.all(
    ROLES.map(async (role) => [role, await make(role)] as const),
  );
  return Object.fromEntries(entries) as Record<Role, KeyPairSigner>;
}

// Devnet keys live in the lab home (0700 directory, 0600 files) and are reused across runs.
async function devnetKeys() {
  const directory = join(labLayout(process.env).root, 'batch-channel-check');
  await mkdir(directory, {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  const path = join(directory, 'keys.json');
  let stored: Record<string, number[]>;
  try {
    stored = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      number[]
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    stored = Object.fromEntries(
      ROLES.map((role) => {
        const keyMaterial = generateKeyPairSync('ed25519').privateKey.export({
          format: 'jwk',
        });
        return [
          role,
          [
            ...Buffer.from(keyMaterial.d!, 'base64url'),
            ...Buffer.from(keyMaterial.x!, 'base64url'),
          ],
        ];
      }),
    );
    await writeFile(path, JSON.stringify(stored), {
      flag: 'wx',
      mode: FILE_MODES.privateFile,
    });
  }
  return signersByRole((role) =>
    createKeyPairSignerFromBytes(Uint8Array.from(stored[role] ?? [])),
  );
}

async function fundDevnet(funder: KeyPairSigner, facilitator: KeyPairSigner) {
  const genesis = await rpc<string>('getGenesisHash', []);
  if (!genesis.startsWith(DEVNET_GENESIS_PREFIX))
    throw new Error('the RPC is not devnet');
  if ((await solBalance(funder.address)) < FUNDER_MINIMUM) {
    try {
      await airdrop(funder.address, DEVNET_AIRDROP_LAMPORTS);
    } catch {
      console.error(
        `Fund the funder with about 0.1 devnet SOL at https://faucet.solana.com, then run again: ${funder.address}`,
      );
      process.exit(2);
    }
  }
  if ((await solBalance(facilitator.address)) < FACILITATOR_MINIMUM)
    await send(funder, [
      getTransferSolInstruction({
        source: funder,
        destination: facilitator.address,
        amount: FACILITATOR_TOP_UP,
      }),
    ]);
}

async function tokenBalance(owner: Address, mint: Address): Promise<bigint> {
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const info = await rpc<{ value: { amount: string } | null } | null>(
    'getTokenAccountBalance',
    [ata, { commitment: 'confirmed' }],
  ).catch(() => null);
  return BigInt(info?.value?.amount ?? 0);
}

async function solBalance(owner: Address): Promise<bigint> {
  const { value } = await rpc<{ value: number }>('getBalance', [
    owner,
    { commitment: 'confirmed' },
  ]);
  return BigInt(value);
}

async function createTestMint(
  feePayer: KeyPairSigner,
  owners: Address[],
  buyer: Address,
) {
  const mint = await generateKeyPairSigner();
  const rent = await rpc<number>('getMinimumBalanceForRentExemption', [
    Number(MINT_SPACE),
  ]);
  const accounts = await Promise.all(
    owners.map((owner) =>
      getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: feePayer,
        owner,
        mint: mint.address,
      }),
    ),
  );
  const [buyerAta] = await findAssociatedTokenPda({
    owner: buyer,
    mint: mint.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  await send(feePayer, [
    getCreateAccountInstruction({
      payer: feePayer,
      newAccount: mint,
      lamports: BigInt(rent),
      space: MINT_SPACE,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals: DECIMALS,
      mintAuthority: feePayer.address,
      freezeAuthority: null,
    }),
    ...accounts,
    getMintToInstruction({
      mint: mint.address,
      token: buyerAta,
      mintAuthority: feePayer,
      amount: BUYER_TOKENS,
    }),
  ]);
  return mint.address;
}

async function main() {
  const keys = ON_DEVNET
    ? await devnetKeys()
    : await signersByRole(() => generateKeyPairSigner());
  const { funder, buyer, payTo, receiverAuthorizer, operator } = keys;
  const facilitatorKey = keys.facilitator;
  if (ON_DEVNET) await fundDevnet(funder, facilitatorKey);
  else for (const key of [funder, facilitatorKey]) await airdrop(key.address);
  const treasury = address(DEVNET_TREASURY_OWNER);
  const mint = await createTestMint(
    funder,
    [buyer.address, payTo.address, facilitatorKey.address, treasury],
    buyer.address,
  );

  const facilitator = new x402Facilitator().register(
    DEVNET,
    new BatchFacilitator(
      toFacilitatorSvmSigner(facilitatorKey, { defaultRpcUrl: RPC_URL }),
      {
        channelStorage: new InMemoryBatchChannelStorage(),
      },
    ),
  );
  const trace = (step: string, result: unknown) => {
    if (process.env.CHECK_TRACE) console.error(step, JSON.stringify(result));
    return result;
  };
  const facilitatorClient: FacilitatorClient = {
    verify: async (payload, requirements) =>
      trace('verify', await facilitator.verify(payload, requirements)) as never,
    settle: async (payload, requirements) =>
      trace('settle', await facilitator.settle(payload, requirements)) as never,
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };

  const serverScheme = new BatchServer({
    withdrawDelay: WITHDRAW_DELAY_SECONDS,
    receiverAuthorizer,
    operator,
    store: new MemoryChannelStore(),
  });
  const resource = new x402ResourceServer(facilitatorClient).register(
    DEVNET,
    serverScheme,
  );
  const route = {
    scheme: 'batch-settlement',
    network: DEVNET,
    payTo: payTo.address,
    price: { asset: mint, amount: String(REQUEST_CEILING) },
    extra: { tokenProgram: TOKEN_PROGRAM_ADDRESS },
  };
  const httpServer = new x402HTTPResourceServer(resource, {
    'GET /infer': {
      accepts: [route],
      description: 'Lab check: metered inference stand-in',
      mimeType: 'application/json',
    },
  });
  await httpServer.initialize();

  let served = 0;
  const app = express();
  app.use(
    paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false),
  );
  app.get('/infer', (_request, response) => {
    const charge = METERED[served] ?? 0n;
    served++;
    setSettlementOverrides(response, { amount: String(charge) });
    response.json({
      answer: `stand-in answer ${served}`,
      charged: String(charge),
    });
  });
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/infer`;

  const clientScheme = new BatchClient(buyer, {
    rpcUrl: RPC_URL,
    depositAmount: DEPOSIT,
    serverSignedChannelsPolicy: {
      allowedOperators: [operator.address],
      allowedAssets: [
        { network: DEVNET, asset: mint, maxDeposit: String(DEPOSIT) },
      ],
    },
  });
  // A test mint is not a default asset, so it is allowed explicitly, capped at the request ceiling.
  const client = x402Client.fromConfig({
    schemes: [{ network: 'solana:*', client: clientScheme }],
    policies: [clientScheme.paymentPolicy],
    spendControls: {
      allowedAssets: [
        {
          network: DEVNET,
          asset: mint,
          maxAmountPerPayment: String(REQUEST_CEILING),
        },
      ],
    },
  });
  const pay = wrapFetchWithPayment(fetch, new x402HTTPClient(client));

  const before = {
    buyer: await tokenBalance(buyer.address, mint),
    buyerSol: await solBalance(buyer.address),
    facilitatorSol: await solBalance(facilitatorKey.address),
  };
  const report: Record<string, unknown> = {
    rpc: RPC_URL,
    program: 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX',
  };

  const responses: { status: number; body: unknown }[] = [];
  for (let request = 0; request < METERED.length; request++) {
    const response = await pay(url);
    responses.push({ status: response.status, body: await response.json() });
    if (!response.ok) break;
  }
  report.requests = responses;
  report.afterRequests = {
    buyer: String(await tokenBalance(buyer.address, mint)),
    payTo: String(await tokenBalance(payTo.address, mint)),
  };

  const supported = await facilitatorClient.getSupported();
  const kind = supported.kinds.find(
    (entry) => entry.scheme === 'batch-settlement' && entry.network === DEVNET,
  );
  if (!kind) throw new Error('facilitator does not advertise batch-settlement');
  const requirements = await serverScheme.enhancePaymentRequirements(
    {
      scheme: 'batch-settlement',
      network: DEVNET,
      amount: String(REQUEST_CEILING),
      asset: mint,
      payTo: payTo.address,
      maxTimeoutSeconds: 300,
      extra: { tokenProgram: TOKEN_PROGRAM_ADDRESS },
    },
    kind,
    [],
  );
  const manager = serverScheme.createChannelManager(
    facilitatorClient,
    requirements,
    {
      rpcUrl: RPC_URL,
    },
  );
  report.redemption = await manager.redeem();
  report.afterRedemption = {
    buyer: String(await tokenBalance(buyer.address, mint)),
    payTo: String(await tokenBalance(payTo.address, mint)),
    treasury: String(await tokenBalance(treasury, mint)),
  };

  report.refund = await clientScheme.refund(url);
  const metered = METERED.reduce((sum, charge) => sum + charge, 0n);
  const after = {
    buyer: await tokenBalance(buyer.address, mint),
    payTo: await tokenBalance(payTo.address, mint),
    treasury: await tokenBalance(treasury, mint),
    buyerSol: await solBalance(buyer.address),
    facilitatorSol: await solBalance(facilitatorKey.address),
  };
  report.final = {
    meteredTotal: String(metered),
    buyerSpent: String(before.buyer - after.buyer),
    payTo: String(after.payTo),
    programTreasury: String(after.treasury),
    buyerSolSpentLamports: String(before.buyerSol - after.buyerSol),
    facilitatorSolSpentLamports: String(
      before.facilitatorSol - after.facilitatorSol,
    ),
  };
  console.log(
    JSON.stringify(
      report,
      (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      2,
    ),
  );
  listener.close();
}

await main();
