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
    async write(text) {
      if (!ownership) throw new Error('Conversation storage unavailable');
      await ownership.verify();
      await writePrivateFile(paths.state, text, CHAT_STORAGE.MAX_BYTES);
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
