// Lab check of one long-lived x402 batch-settlement channel on Solana: the buyer deposits once, pays
// several requests with server-signed metered vouchers, the seller redeems them in one batch, the
// protocol fee goes to the Gyblos treasury through the channel's committed distribution (extra.splits,
// the monorepo's @x402/svm patch) and the buyer gets the unused escrow back. Official SDK pieces only
// (client, server, facilitator) against the payment-channels program. By default it runs on a
// loopback validator that loads the program dumped from devnet, with throwaway keys; with --devnet
// (founder-approved runs only) it uses the public devnet RPC. A fresh test mint either way, never
// USDC. It fails unless every amount matches what the distribution should pay. See docs/payments.md.
import type { AddressInfo } from 'node:net';

import { address, generateKeyPairSigner } from '@solana/kit';
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
import { BATCH_SETTLEMENT_SCHEME, toFacilitatorSvmSigner } from '@x402/svm';
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
  CHANNEL_PROGRAM,
  DEVNET,
  DEVNET_RPC_URL,
  DEVNET_TREASURY_OWNER,
  HTTP_STATUS,
  PROTOCOL_FEE,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config';
import { PAYMENT_BINDING } from '@gyblos/protocol/constants';

import { chainClient } from './chain';
import {
  devnetKeys,
  fundDevnet,
  signersByRole,
  spaceDevnetRequests,
} from './devnet';

const LOOPBACK_RPC = 'http://127.0.0.1:8899';
const BUYER_TOKENS = 100_000n;
// Ceiling per request; the operator signs the metered charge after serving.
const REQUEST_CEILING = 1_000n;
// The SDK caps a deposit at 5 × the spend cap per payment (REQUEST_CEILING), so 5,000.
const DEPOSIT = 5_000n;
const FIRST_CHARGE = 145n;
const SECOND_CHARGE = 210n;
const THIRD_CHARGE = 95n;
const METERED = [FIRST_CHARGE, SECOND_CHARGE, THIRD_CHARGE];
// The SDK accepts 900 s to 30 days; a cooperative refund does not wait for it.
const WITHDRAW_DELAY_SECONDS = 900;
const REQUIREMENTS_TIMEOUT_SECONDS = 300;
const BPS = BigInt(PAYMENT_BINDING.bpsDenominator);
const FAILED = 1;

function rpcUrlFor(onDevnet: boolean, environment: NodeJS.ProcessEnv) {
  const url = onDevnet
    ? DEVNET_RPC_URL
    : (environment.CHECK_RPC_URL ?? LOOPBACK_RPC);
  if (!onDevnet && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url))
    throw new Error(
      'without --devnet, batch-channel-check runs only against a loopback validator',
    );
  return url;
}

// What the committed distribution must pay for `total`: each share floored, the remainder to the
// program treasury.
function expectedPayout(total: bigint) {
  const fee = (total * BigInt(PROTOCOL_FEE.bps)) / BPS;
  const seller = (total * (BPS - BigInt(PROTOCOL_FEE.bps))) / BPS;
  return { seller, fee, programTreasury: total - seller - fee };
}

export async function batchChannelCheck(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  const onDevnet = argv.includes('--devnet');
  const rpcUrl = rpcUrlFor(onDevnet, environment);
  if (onDevnet) spaceDevnetRequests();
  const chain = chainClient(rpcUrl);
  const { tokenBalance, solBalance } = chain;

  const keys = onDevnet
    ? await devnetKeys(environment)
    : await signersByRole(() => generateKeyPairSigner());
  const { funder, buyer, payTo, receiverAuthorizer, operator } = keys;
  const facilitatorKey = keys.facilitator;
  if (onDevnet) await fundDevnet(chain, funder, facilitatorKey);
  else
    for (const key of [funder, facilitatorKey])
      await chain.airdrop(key.address);
  const treasury = address(DEVNET_TREASURY_OWNER);
  const gyblos = address(PROTOCOL_FEE.treasury);
  // Every distribution recipient needs a token account before redemption; the mint creates them.
  const mint = await chain.createTestMint(
    funder,
    [buyer.address, payTo.address, facilitatorKey.address, treasury, gyblos],
    buyer.address,
    BUYER_TOKENS,
  );

  const facilitator = new x402Facilitator().register(
    DEVNET,
    new BatchFacilitator(
      toFacilitatorSvmSigner(facilitatorKey, { defaultRpcUrl: rpcUrl }),
      { channelStorage: new InMemoryBatchChannelStorage() },
    ),
  );
  const trace = <T>(step: string, result: T): T => {
    if (environment.CHECK_TRACE) console.error(step, JSON.stringify(result));
    return result;
  };
  const facilitatorClient: FacilitatorClient = {
    verify: async (payload, requirements) =>
      trace('verify', await facilitator.verify(payload, requirements)),
    settle: async (payload, requirements) =>
      trace('settle', await facilitator.settle(payload, requirements)),
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
  // payTo first with the remainder, then the protocol fee, as the patched SDK expects. The splits
  // are fixed for the channel's life: changing them would make every later check on it fail.
  const splits = [
    { recipient: payTo.address, bps: Number(BPS) - PROTOCOL_FEE.bps },
    { recipient: gyblos, bps: PROTOCOL_FEE.bps },
  ];
  const extra = { tokenProgram: TOKEN_PROGRAM_ADDRESS, splits };
  const httpServer = new x402HTTPResourceServer(resource, {
    'GET /infer': {
      accepts: [
        {
          scheme: BATCH_SETTLEMENT_SCHEME,
          network: DEVNET,
          payTo: payTo.address,
          price: { asset: mint, amount: String(REQUEST_CEILING) },
          extra,
        },
      ],
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

  try {
    const clientScheme = new BatchClient(buyer, {
      rpcUrl,
      depositAmount: DEPOSIT,
      // The buyer accepts only the published distribution: the seller and the Gyblos fee.
      approveSplits: (offered) =>
        JSON.stringify(offered) ===
        JSON.stringify(
          splits.map(({ bps, recipient }) => ({ bps, recipient })),
        ),
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
      rpc: rpcUrl,
      program: CHANNEL_PROGRAM,
    };

    const responses: { status: number; body: unknown }[] = [];
    for (let request = 0; request < METERED.length; request++) {
      const response = await pay(url);
      responses.push({ status: response.status, body: await response.json() });
      if (!response.ok) break;
    }
    report.requests = responses;

    const supported = await facilitatorClient.getSupported();
    const kind = supported.kinds.find(
      (entry) =>
        entry.scheme === BATCH_SETTLEMENT_SCHEME && entry.network === DEVNET,
    );
    if (!kind)
      throw new Error('facilitator does not advertise batch-settlement');
    const requirements = await serverScheme.enhancePaymentRequirements(
      {
        scheme: BATCH_SETTLEMENT_SCHEME,
        network: DEVNET,
        amount: String(REQUEST_CEILING),
        asset: mint,
        payTo: payTo.address,
        maxTimeoutSeconds: REQUIREMENTS_TIMEOUT_SECONDS,
        extra,
      },
      kind,
      [],
    );
    const manager = serverScheme.createChannelManager(
      facilitatorClient,
      requirements,
      { rpcUrl },
    );
    report.redemption = await manager.redeem();
    const refund = await clientScheme.refund(url);
    report.refund = refund;

    const metered = METERED.reduce((sum, charge) => sum + charge, 0n);
    // Absolute balances are the payouts because every run creates a fresh mint.
    const after = {
      buyer: await tokenBalance(buyer.address, mint),
      payTo: await tokenBalance(payTo.address, mint),
      gyblos: await tokenBalance(gyblos, mint),
      treasury: await tokenBalance(treasury, mint),
      buyerSol: await solBalance(buyer.address),
      facilitatorSol: await solBalance(facilitatorKey.address),
    };
    const expected = expectedPayout(metered);
    const final = {
      meteredTotal: metered,
      buyerSpent: before.buyer - after.buyer,
      payTo: after.payTo,
      gyblosFee: after.gyblos,
      programTreasury: after.treasury,
      refunded: refund.success ? BigInt(refund.amount ?? 0) : 0n,
      buyerSolSpentLamports: before.buyerSol - after.buyerSol,
      facilitatorSolSpentLamports: before.facilitatorSol - after.facilitatorSol,
    };
    report.final = final;
    const mismatches = [
      responses.every(({ status }) => status === HTTP_STATUS.ok) &&
      responses.length === METERED.length
        ? undefined
        : 'not every request was paid and served',
      final.buyerSpent === metered ? undefined : 'buyer spent',
      final.payTo === expected.seller ? undefined : 'seller payout',
      final.gyblosFee === expected.fee ? undefined : 'protocol fee',
      final.programTreasury === expected.programTreasury
        ? undefined
        : 'program treasury rounding',
      final.refunded === DEPOSIT - metered ? undefined : 'refund',
      final.buyerSolSpentLamports === 0n ? undefined : 'buyer SOL',
    ].filter((mismatch) => mismatch !== undefined);
    report.mismatches = mismatches;
    console.log(
      JSON.stringify(
        report,
        (_key, value: unknown) =>
          typeof value === 'bigint' ? String(value) : value,
        2,
      ),
    );
    if (mismatches.length) process.exitCode = FAILED;
  } finally {
    listener.close();
  }
}
