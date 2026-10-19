export interface PublicCall {
  operation: string;
  url: string;
  outcome: string;
  transaction?: string;
  reason?: string;
  message?: string;
  payer?: string;
}
