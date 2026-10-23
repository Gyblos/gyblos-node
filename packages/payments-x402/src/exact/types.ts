// Record of one call to a public facilitator (operation, outcome, optional transaction and reason).
import type { PublicCallOperation, PublicCallOutcome } from '../constants.js';

export interface PublicCall {
  operation: PublicCallOperation;
  url: string;
  outcome: PublicCallOutcome;
  transaction?: string;
  reason?: string;
  message?: string;
  payer?: string;
}
