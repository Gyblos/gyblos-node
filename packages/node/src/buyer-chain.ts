// Free-only profiles still honor unfinished reusable payment channels.
import {
  batchPoolPathsIn,
  batchSessionPathsIn,
} from '@gyblos/config/home-payments';
import {
  batchSessionTerminal,
  inspectBatchPool,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import { P2P_ROLES } from '@gyblos/protocol/constants';

export async function buyerPaymentsUnresolved() {
  const pool = await inspectBatchPool(batchPoolPathsIn(process.env));
  if (
    pool.some(
      (entry) =>
        !entry.stored || entry.uncertain || !batchSessionTerminal(entry.stored),
    )
  )
    return true;
  const session = await inspectBatchSession(
    batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
  );
  return session !== undefined && !batchSessionTerminal(session);
}
