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
