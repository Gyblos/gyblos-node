// Restricts private conversation IPC to the current owning main frame and exact arity.
import { unavailableChatArchive } from './chat-archive-model';
import type { ChatArchiveStore } from './chat-archive-store';

type Owner = { contents: unknown; mainFrame(): unknown; destroyed(): boolean };
type Sender = { sender: unknown; senderFrame: unknown };
export function createChatArchiveHandlers(
  store: ChatArchiveStore,
  owner: Owner,
) {
  const accepts = (event: Sender) =>
    !owner.destroyed() &&
    event.sender === owner.contents &&
    event.senderFrame === owner.mainFrame();
  return {
    load: (event: Sender, args: readonly unknown[]) =>
      accepts(event) && args.length === 0
        ? store.load()
        : Promise.resolve({ ...unavailableChatArchive(), archive: null }),
    save: (event: Sender, args: readonly unknown[]) =>
      accepts(event) && args.length === 1
        ? store.save(args[0])
        : unavailableChatArchive(),
    status: (event: Sender, args: readonly unknown[]) =>
      accepts(event) && args.length === 0
        ? store.status()
        : unavailableChatArchive(),
  };
}
