// Authenticates the owning main frame before reading descriptive local history.
import {
  activityId,
  unavailableActivity,
  type ActivityResult,
} from './activity-model';
import {
  parsePaymentReferences,
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
  copy: (value: string) => void = () => {
    throw new Error('Clipboard unavailable');
  },
) {
  const accepts = (event: Sender, args: readonly unknown[]) =>
    args.length === 0 &&
    !owner.destroyed() &&
    event.sender === owner.contents &&
    event.senderFrame === owner.mainFrame();
  return {
    accepts,
    async copy(event: Sender, args: readonly unknown[]) {
      if (!accepts(event, []) || args.length !== 1 || !activityId(args[0]))
        return false;
      try {
        const result = parsePaymentReferences(await references());
        const reference = result.available
          ? result.references.find((item) => item.sessionId === args[0])
          : undefined;
        if (!reference) return false;
        copy(reference.id);
        return true;
      } catch {
        return false;
      }
    },
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
