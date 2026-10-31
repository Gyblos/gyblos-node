// `pnpm buyer:withdraw:paid`: takes each stuck paid channel one step toward a refund on devnet, signed
// and paid by the buyer's wallet; prints one JSON line per channel and a summary, never keys or URLs.
// Run it again after `retryAfterSeconds` while it exits 2, then `pnpm buyer:reconcile:paid`.
import {
  buyerChainWithdraw,
  WITHDRAW_STEPS,
} from '@gyblos/node/buyer-withdraw';
import { isMain } from '@gyblos/runtime';

import { PAID_WITHDRAW_CODES, PAID_WITHDRAW_EXIT } from './constants';
import { buyerRole, paidChainFailure } from './reconcile-paid';

// Steps after which the channel still needs another run.
const AGAIN: readonly string[] = [
  WITHDRAW_STEPS.CLAIMABLE,
  WITHDRAW_STEPS.CLOSE_REQUESTED,
  WITHDRAW_STEPS.WAITING,
];

export async function main(
  withdraw: ReturnType<typeof buyerChainWithdraw> = buyerChainWithdraw(),
  print: (line: string) => void = console.log,
) {
  try {
    const role = await buyerRole();
    const results = await withdraw(role, async (result) => {
      print(JSON.stringify(result));
    });
    const summary = Object.fromEntries(
      Object.values(WITHDRAW_STEPS).map((step) => [
        step,
        results.filter((result) => result.step === step).length,
      ]),
    );
    const waits = results
      .map((result) => result.retryAfterSeconds)
      .filter((seconds) => seconds !== null);
    const retryAfterSeconds = waits.length ? Math.min(...waits) : null;
    print(JSON.stringify({ summary, retryAfterSeconds }));
    if (summary[WITHDRAW_STEPS.REFUSED]) {
      console.error(PAID_WITHDRAW_CODES.REFUSED);
      process.exitCode = PAID_WITHDRAW_EXIT.FAILED;
    } else if (
      results.some((result) => AGAIN.includes(result.step) || !result.confirmed)
    )
      process.exitCode = PAID_WITHDRAW_EXIT.AGAIN;
    return results;
  } catch (error) {
    console.error(paidChainFailure(error, PAID_WITHDRAW_CODES));
    process.exitCode = PAID_WITHDRAW_EXIT.FAILED;
    return undefined;
  }
}

if (isMain(import.meta.url)) await main();
