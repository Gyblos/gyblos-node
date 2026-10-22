// Owns types in payments-x402; it must not know inference engines or lab orchestration.
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
