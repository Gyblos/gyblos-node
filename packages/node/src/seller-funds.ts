// Waits until the seller owner's balance reaches a target, reading it from the role's registration RPC.
// Read-only: it never signs or sends anything. A few failed reads in a row end the wait, as does an abort.
import { setTimeout as delay } from 'node:timers/promises';

import { address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import { createIdentityRegistrationRpc } from '@gyblos/identity/resolution-rpc';

// How often the owner's balance is read, as milliseconds and as told to the operator; how long the wait
// lasts (the operator can run the command again at any time); and how many failed reads in a row end it.
export const SELLER_FUNDS = {
  pollMs: 15_000,
  pollText: '15 s',
  waitMs: 1_800_000, // 30 minutes
  maxFailedReads: 4,
} as const;

// How a wait ended: the balance was already enough, it arrived while waiting, the wait ran out, the
// operator stopped it, or the balance could not be read.
export const FUNDS_WAIT = {
  FUNDED: 'funded',
  ARRIVED: 'arrived',
  TIMEOUT: 'timeout',
  STOPPED: 'stopped',
  UNREADABLE: 'unreadable',
} as const;
export type FundsWaitResult = (typeof FUNDS_WAIT)[keyof typeof FUNDS_WAIT];

export interface OwnerFundsWait {
  rpcUrl: string;
  owner: string;
  lamports: bigint;
  // Aborting it (Ctrl+C on the operator's terminal) stops the wait.
  signal?: AbortSignal;
  // Called once, when the first read does not reach the target and the wait begins.
  onWaiting?: () => void;
  rpc?: Pick<Rpc<SolanaRpcApi>, 'getBalance'>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

export async function waitForOwnerFunds(
  input: OwnerFundsWait,
): Promise<FundsWaitResult> {
  const rpc = input.rpc ?? createIdentityRegistrationRpc(input.rpcUrl);
  const sleep =
    input.sleep ??
    ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  const now = input.now ?? Date.now;
  const deadline = now() + (input.waitMs ?? SELLER_FUNDS.waitMs);
  let waiting = false;
  let failed = 0;
  for (;;) {
    if (input.signal?.aborted) return FUNDS_WAIT.STOPPED;
    const balance = await balanceOf(rpc, input.owner);
    if (balance === undefined) {
      failed += 1;
      if (failed >= SELLER_FUNDS.maxFailedReads) return FUNDS_WAIT.UNREADABLE;
    } else {
      failed = 0;
      if (balance >= input.lamports)
        return waiting ? FUNDS_WAIT.ARRIVED : FUNDS_WAIT.FUNDED;
    }
    if (!waiting) {
      waiting = true;
      input.onWaiting?.();
    }
    if (now() >= deadline) return FUNDS_WAIT.TIMEOUT;
    try {
      await sleep(input.pollMs ?? SELLER_FUNDS.pollMs, input.signal);
    } catch {
      return FUNDS_WAIT.STOPPED;
    }
  }
}
