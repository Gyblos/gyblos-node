// The paid buyer's static refusals, raised before any payment.
import type { PaidBuyerCode } from './constants';

export class PaidBuyerError extends Error {
  constructor(readonly code: PaidBuyerCode) {
    super(code);
    this.name = 'PaidBuyerError';
  }
}
