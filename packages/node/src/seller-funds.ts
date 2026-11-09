// Waits until the seller owner's balance reaches a target, reading it from the role's registration RPC.
// Read-only: it never signs or sends anything. A failed read is retried until the deadline.
import { setTimeout as delay } from 'node:timers/promises';

import { address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import { createIdentityRegistrationRpc } from '@gyblos/identity/resolution-rpc';

// How often the owner's balance is read, as milliseconds and as told to the operator, and how long the
// wait lasts before giving up (the operator can run the command again at any time).
export const SELLER_FUNDS = {
  pollMs: 15_000,
  pollText: '15 s',
  waitMs: 1_800_000, // 30 minutes
} as const;

export interface OwnerFundsWait {
  rpcUrl: string;
  owner: string;
  lamports: bigint;
  rpc?: Pick<Rpc<SolanaRpcApi>, 'getBalance'>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  waitMs?: number;
}

async function balanceOf(
  rpc: Pick<Rpc<SolanaRpcApi>, 'getBalance'>,
  owner: string,
) {
  try {
    return (await rpc.getBalance(address(owner)).send()).value;
  } catch {
    return undefined;
  }
}

// true once the balance reaches the target; false when the wait ends without it.
export async function waitForOwnerFunds(input: OwnerFundsWait) {
  const rpc = input.rpc ?? createIdentityRegistrationRpc(input.rpcUrl);
  const sleep = input.sleep ?? ((ms: number) => delay(ms));
  const now = input.now ?? Date.now;
  const deadline = now() + (input.waitMs ?? SELLER_FUNDS.waitMs);
  for (;;) {
    const balance = await balanceOf(rpc, input.owner);
    if (balance !== undefined && balance >= input.lamports) return true;
    if (now() >= deadline) return false;
    await sleep(input.pollMs ?? SELLER_FUNDS.pollMs);
  }
}
