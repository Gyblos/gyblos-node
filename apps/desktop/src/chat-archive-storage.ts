// Stores conversations under the private desktop profile, separately from wallet and payment data.
import { desktopChatPaths } from '@gyblos/config/home';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import { ChatArchiveStore } from './chat-archive-store';
import { CHAT_STORAGE } from './constants';

export function createChatArchiveStorage(profile: string) {
  const paths = desktopChatPaths(profile);
  let ownership: ProcessLock | undefined;
  let closing: Promise<void> | undefined;
  const store = new ChatArchiveStore({
    async read() {
      await ensurePrivateDirectory(paths.directory);
      ownership = await acquireProcessLock(paths.lock);
      return readPrivateFile(paths.state, CHAT_STORAGE.MAX_BYTES);
    },
    async readPins() {
      try {
        const text = await readPrivateFile(paths.pins, CHAT_STORAGE.MAX_BYTES);
        if (!text) return [];
        const pins: unknown = JSON.parse(text);
        return Array.isArray(pins) &&
          pins.length <= CHAT_STORAGE.MAX_CONVERSATIONS
          ? pins.filter((id): id is string => typeof id === 'string')
          : [];
      } catch {
        return [];
      }
    },
    async write(text, pins) {
      if (!ownership) throw new Error('Conversation storage unavailable');
      await ownership.verify();
      await writePrivateFile(paths.state, text, CHAT_STORAGE.MAX_BYTES);
      await writePrivateFile(
        paths.pins,
        JSON.stringify(pins),
        CHAT_STORAGE.MAX_BYTES,
      );
    },
  });
  return {
    store,
    close() {
      closing ??= store.close().finally(() => ownership?.release());
      return closing;
    },
  };
}
