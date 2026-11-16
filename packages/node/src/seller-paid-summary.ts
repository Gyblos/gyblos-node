// What `gyblos seller status` shows about paid requests: a read-only summary of this home's seller payment
// ledger (recent settled requests and what they charged, and what is still settling). No lock, no write.
import { paymentPathsIn, type HomeEnvironment } from '@gyblos/config';
import {
  readUptoLedgerSummary,
  type UptoLedgerSummary,
} from '@gyblos/payments-upto';
import { P2P_ROLES } from '@gyblos/protocol/constants';

export function sellerPaidSummary(
  environment: HomeEnvironment,
  since: number,
  now: number,
): Promise<UptoLedgerSummary | undefined> {
  return readUptoLedgerSummary(
    paymentPathsIn(environment, P2P_ROLES.SELLER),
    since,
    now,
  );
}
