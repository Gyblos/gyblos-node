// Owns the laboratory devnet run of the sponsored identity flow, if the public faucet funds the sponsor.
// Refuses any RPC whose genesis is not devnet before loading keys; prints addresses and costs only.
import {
  createKeyPairFromPrivateKeyBytes,
  createSolanaRpc,
  devnet,
  isSolanaError,
  lamports,
} from '@solana/kit';

import { DEVNET_RPC_URL } from '@gyblos/config';
import { detachedSignerFromKeyPair } from '@gyblos/identity';
import { assertDevnet } from '@gyblos/payments-x402/chain';
import { isMain } from '@gyblos/runtime';

import { confirm, printable, runSponsoredFlow } from './identity-flow.js';
import { loadOrCreateKey } from './identity-keys.js';

const AIRDROP_LAMPORTS = 1_000_000_000n;
const MIN_SPONSOR_LAMPORTS = 60_000_000n;
const AGENT_URI = 'https://gyblos.com/.well-known/node.json';

async function detached(name: string) {
  const { seed } = await loadOrCreateKey(name);
  return detachedSignerFromKeyPair(
    await createKeyPairFromPrivateKeyBytes(seed),
  );
}

export interface SponsorFunding {
  balance(): Promise<bigint>;
  airdrop(): Promise<void>;
  log(line: string): void;
}

// RPC errors can echo provider URLs with credentials, so only a static reason
// and the numeric SDK error code ever reach the console.
export function airdropFailureReason(error: unknown) {
  const code = isSolanaError(error)
    ? ` (SolanaError ${error.context.__code})`
    : '';
  return `SKIPPED devnet run: faucet refused airdrop${code}`;
}

export async function fundSponsor(
  funding: SponsorFunding,
): Promise<bigint | undefined> {
  const funded = await funding.balance();
  if (funded >= MIN_SPONSOR_LAMPORTS) return funded;
  try {
    await funding.airdrop();
  } catch (error) {
    funding.log(airdropFailureReason(error));
    return undefined;
  }
  return funding.balance();
}

async function main(): Promise<void> {
  const url = process.env.GYBLOS_RPC_URL ?? DEVNET_RPC_URL;
  await assertDevnet(url);
  const rpc = createSolanaRpc(devnet(url));
  const sponsor = (await loadOrCreateKey('devnet-sponsor')).signer;
  console.log('sponsor', sponsor.address);
  const funded = await fundSponsor({
    balance: async () => (await rpc.getBalance(sponsor.address).send()).value,
    airdrop: async () =>
      confirm(
        rpc,
        await rpc
          .requestAirdrop(sponsor.address, lamports(AIRDROP_LAMPORTS))
          .send(),
      ),
    log: (line) => console.log(line),
  });
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

if (isMain(import.meta.url)) await main();
