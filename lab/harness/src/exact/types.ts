// Record of one call to a public facilitator (operation, outcome, optional transaction and reason).
import type { PublicCallOperation } from '@gyblos/payments-x402/constants';

import type { PublicCallOutcome } from '../constants.js';

export interface PublicCall {
  operation: PublicCallOperation;
  url: string;
  outcome: PublicCallOutcome;
  transaction?: string;
  reason?: string;
  message?: string;
  payer?: string;
}
