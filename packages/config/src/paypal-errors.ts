// Static configuration refusal without environment values or credentials.
import { PAYPAL_CONFIG_ERROR } from './constants';

export class PaypalConfigError extends Error {
  readonly code = PAYPAL_CONFIG_ERROR;
  constructor() {
    super(PAYPAL_CONFIG_ERROR);
    this.name = 'PaypalConfigError';
  }
}
