// Runs the payment port contract against the in-memory reference pair; no chain or network is used.
import { paymentContract } from './support/payment-contract';
import { memoryPaymentHarness } from './support/payment-memory';

paymentContract('memory', memoryPaymentHarness);
