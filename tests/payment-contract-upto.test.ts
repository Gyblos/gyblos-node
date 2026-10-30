// Runs the shared payment port contract against @gyblos/payments-upto over the real x402 upto SDK
// (offline verify, 3% distribution) and a synthetic ledger; no network or real funds.
import { paymentContract } from './support/payment-contract';
import { uptoPaymentHarness } from './support/payment-upto';

paymentContract('upto', uptoPaymentHarness);
