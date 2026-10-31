// `pnpm buyer:reconcile:paid`: resolves the paid buyer's open channels from finalized devnet history
// against the buyer's own records, unblocking new payments for each one the chain has resolved. Reads
// only the chain; prints one JSON line per channel; never prints keys, RPC URLs or paths.
import {
  buyerChainReconcile,
  RECONCILE_OUTCOMES,
} from '@gyblos/node/buyer-reconcile';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { loadRole, rolePath } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

import { PAID_BUYER, PAID_RECONCILE_CODES } from './constants';
import { appendPrivateLine, paidRecords } from './paid-records';

// A failure's static code: what to fix before reconciling again.
export function reconcileFailure(error: unknown) {
  const code = error instanceof NodeError ? error.code : undefined;
  if (code === NODE_ERROR_CODES.BUYER_PAYMENT_NETWORK_MISMATCH)
    return PAID_RECONCILE_CODES.NETWORK;
  if (code === NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID)
    return PAID_RECONCILE_CODES.ROLE;
  return PAID_RECONCILE_CODES.INCOMPLETE;
}

export async function main(
  reconcile: ReturnType<typeof buyerChainReconcile> = buyerChainReconcile(),
  print: (line: string) => void = console.log,
) {
  try {
    const role = await loadRole(P2P_ROLES.BUYER);
    const expected = await paidRecords(
      rolePath(P2P_ROLES.BUYER, PAID_BUYER.recordsFile),
    ).expectations();
    const results = await reconcile(role, (digest) => expected.get(digest));
    const done = rolePath(P2P_ROLES.BUYER, PAID_BUYER.reconciliationsFile);
    for (const result of results) {
      if (result.outcome !== RECONCILE_OUTCOMES.OPEN)
        await appendPrivateLine(done, result);
      print(JSON.stringify(result));
    }
    // Channels still open keep blocking payments; the run itself succeeded.
    return results;
  } catch (error) {
    console.error(reconcileFailure(error));
    process.exitCode = 1;
    return undefined;
  }
}

if (isMain(import.meta.url)) await main();
