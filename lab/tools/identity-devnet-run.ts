// Owns the laboratory devnet run of the sponsored identity flow, if the public faucet funds the sponsor.
// Refuses any RPC whose genesis is not devnet before loading keys; prints addresses and costs only.
import {
  createKeyPairFromPrivateKeyBytes,
  createSolanaRpc,
  devnet,
  lamports,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { DEVNET_RPC_URL } from '@gyblos/config';
import { detachedSignerFromKeyPair } from '@gyblos/identity';
import { assertDevnet } from '@gyblos/payments-x402/chain';

import { confirm, printable, runSponsoredFlow } from './identity-flow.js';
import { loadOrCreateKey } from './identity-keys.js';

const AIRDROP_LAMPORTS = 1_000_000_000n;
const MIN_SPONSOR_LAMPORTS = 60_000_000n;
const ERROR_PREVIEW_CHARACTERS = 200;
const AGENT_URI = 'https://gyblos.com/.well-known/node.json';

async function detached(name: string) {
  const { seed } = await loadOrCreateKey(name);
  return detachedSignerFromKeyPair(
    await createKeyPairFromPrivateKeyBytes(seed),
  );
}

async function fundSponsor(
  rpc: Rpc<SolanaRpcApi>,
  sponsor: Awaited<ReturnType<typeof loadOrCreateKey>>['signer'],
): Promise<bigint | undefined> {
  const funded = (await rpc.getBalance(sponsor.address).send()).value;
  if (funded >= MIN_SPONSOR_LAMPORTS) return funded;
  try {
    await confirm(
      rpc,
      await rpc
        .requestAirdrop(sponsor.address, lamports(AIRDROP_LAMPORTS))
        .send(),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(
      'SKIPPED devnet run: faucet refused airdrop:',
      detail.slice(0, ERROR_PREVIEW_CHARACTERS),
    );
    return undefined;
  }
  return (await rpc.getBalance(sponsor.address).send()).value;
}

async function main(): Promise<void> {
  const url = process.env.GYBLOS_RPC_URL ?? DEVNET_RPC_URL;
  await assertDevnet(url);
  const rpc = createSolanaRpc(devnet(url));
  const sponsor = (await loadOrCreateKey('devnet-sponsor')).signer;
  console.log('sponsor', sponsor.address);
  const funded = await fundSponsor(rpc, sponsor);
  if (funded === undefined) return;
  console.log('sponsor balance', String(funded));
  const participants = {
    owner: (await loadOrCreateKey('devnet-owner')).signer,
    asset: (await loadOrCreateKey(`devnet-asset-${Date.now()}`)).signer,
    node: await detached('devnet-node'),
    payoutWallet: await detached('devnet-payout'),
  };
  console.log(
    printable(
      await runSponsoredFlow(rpc, sponsor, participants, {
        agentUri: AGENT_URI,
        // Unix milliseconds: strictly increasing across runs with the same node key.
        bindingSequence: BigInt(Date.now()),
      }),
    ),
  );
}

await main();
