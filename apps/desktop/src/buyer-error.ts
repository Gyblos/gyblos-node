// Static desktop explanations for validated buyer failures; remote text is never displayed.
// Presentation does not change retry decisions, budget reservations or payment uncertainty.
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

export function desktopBuyerFailure(_value: unknown, _policy: BuyerApiPolicy): Error {
  return new Error('Buyer did not complete the request');
}
