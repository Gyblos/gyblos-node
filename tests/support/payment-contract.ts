// Shared payment port contract: every PaymentClient/PaymentServer pair must keep these money rules
// (listed in packages/protocol/src/payment.ts). Harnesses use synthetic ledgers or devnet doubles;
// no test here moves real funds.
import { paymentClientContract } from './payment-contract-client';
import { paymentServerContract } from './payment-contract-server';
import type { PaymentHarness } from './payment-rig';

export type { PaymentHarness, PaymentRig } from './payment-rig';

// Registers the whole contract for one PaymentClient/PaymentServer pair.
export function paymentContract(name: string, harness: PaymentHarness): void {
  paymentClientContract(name, harness);
  paymentServerContract(name, harness);
}
