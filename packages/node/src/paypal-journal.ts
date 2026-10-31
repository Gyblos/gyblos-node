// Persists the sandbox payment journal under an exclusive process lock, without inference content.
import { paypalSandboxPaths } from '@gyblos/config/home';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import type { PaypalInferenceDependencies } from './paypal-inference';

const MAX_BYTES = 8192;
type Value = Parameters<PaypalInferenceDependencies['journal']['write']>[0];

export async function openPaypalJournal(root: string) {
  const paths = paypalSandboxPaths(root);
  await ensurePrivateDirectory(paths.directory);
  const lock = await acquireProcessLock(paths.lock);
  return {
    async read(): Promise<unknown> {
      await lock.verify();
      const content = await readPrivateFile(paths.state, MAX_BYTES);
      if (content === undefined) return null;
      return JSON.parse(content);
    },
    async write(value: Value): Promise<void> {
      await lock.verify();
      await writePrivateFile(paths.state, JSON.stringify(value), MAX_BYTES);
    },
    close: () => lock.release(),
  };
}
