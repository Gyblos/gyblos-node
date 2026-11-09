// Authenticates the owning main frame before reading descriptive local history.
import { unavailableActivity, type ActivityResult } from './activity-model';
import {
  unavailablePaymentReferences,
  type PaymentReferenceResult,
} from './payment-reference-model';

type Owner = { contents: unknown; mainFrame(): unknown; destroyed(): boolean };
type Sender = { sender: unknown; senderFrame: unknown };
export function createActivityHandlers(
  read: () => Promise<ActivityResult>,
  owner: Owner,
  references: () => Promise<PaymentReferenceResult> = async () =>
    unavailablePaymentReferences(),
) {
  const accepts = (event: Sender, args: readonly unknown[]) =>
    args.length === 0 &&
    !owner.destroyed() &&
    event.sender === owner.contents &&
    event.senderFrame === owner.mainFrame();
  return {
    accepts,
    async references(event: Sender, args: readonly unknown[]) {
      if (!accepts(event, args)) return unavailablePaymentReferences();
      try {
        return await references();
      } catch {
        return unavailablePaymentReferences();
      }
    },
    async summary(event: Sender, args: readonly unknown[]) {
      if (!accepts(event, args)) return unavailableActivity();
      try {
        return await read();
      } catch {
        return unavailableActivity();
      }
    },
  };
}
