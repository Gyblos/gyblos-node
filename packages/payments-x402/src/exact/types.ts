import type {
  PublicCallOperation,
  PublicCallOutcome,
} from '@gyblos/payments-x402/constants';

export interface PublicCall {
  operation: PublicCallOperation;
  url: string;
  outcome: PublicCallOutcome;
  transaction?: string;
  reason?: string;
  message?: string;
  payer?: string;
}
