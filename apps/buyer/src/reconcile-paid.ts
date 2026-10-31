// `pnpm buyer:reconcile:paid`: resolves the paid buyer's open channels from finalized devnet history
// against its own records; prints one JSON line per channel and a summary, never keys, URLs or paths.
// Exits 0 when nothing blocks payments, 2 while a channel stays open, 1 when it could not finish.
import {
  buyerChainReconcile,
  RECONCILE_OUTCOMES,
} from '@gyblos/node/buyer-reconcile';
import { rolePath } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

import {
  PAID_BUYER,
  PAID_RECONCILE_CODES,
  PAID_RECONCILE_EXIT,
} from './constants';
import { buyerRole, paidChainFailure } from './paid-chain';
import { appendPrivateLine, paidRecords } from './paid-records';

export async function main(
  reconcile: ReturnType<typeof buyerChainReconcile> = buyerChainReconcile(),
  print: (line: string) => void = console.log,
) {
  try {
    const role = await buyerRole();
    const expected = await paidRecords(
      rolePath(P2P_ROLES.BUYER, PAID_BUYER.recordsFile),
    ).expectations();
    const done = rolePath(P2P_ROLES.BUYER, PAID_BUYER.reconciliationsFile);
    // A resolution is kept on disk before the journal unblocks it.
    const results = await reconcile(
      role,
      (digest) => expected.get(digest),
      async (result) => {
        if (result.outcome !== RECONCILE_OUTCOMES.OPEN)
          await appendPrivateLine(done, result);
        print(JSON.stringify(result));
      },
    );
    const summary = Object.fromEntries(
      Object.values(RECONCILE_OUTCOMES).map((outcome) => [
        outcome,
        results.filter((result) => result.outcome === outcome).length,
      ]),
    );
    print(JSON.stringify({ summary }));
    if (summary[RECONCILE_OUTCOMES.OPEN])
      process.exitCode = PAID_RECONCILE_EXIT.OPEN;
    return results;
  } catch (error) {
    console.error(paidChainFailure(error, PAID_RECONCILE_CODES));
    process.exitCode = PAID_RECONCILE_EXIT.FAILED;
    return undefined;
  }
}

if (isMain(import.meta.url)) await main();
