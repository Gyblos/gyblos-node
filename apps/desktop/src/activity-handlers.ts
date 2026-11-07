// Authenticates the owning main frame before reading descriptive local history.
import { unavailableActivity, type ActivityResult } from './activity-model';

type Owner = { contents: unknown; mainFrame(): unknown; destroyed(): boolean };
type Sender = { sender: unknown; senderFrame: unknown };
export function createActivityHandlers(
  read: () => Promise<ActivityResult>,
  owner: Owner,
) {
  const accepts = (event: Sender, args: readonly unknown[]) =>
    args.length === 0 &&
    !owner.destroyed() &&
    event.sender === owner.contents &&
    event.senderFrame === owner.mainFrame();
  return {
    accepts,
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
