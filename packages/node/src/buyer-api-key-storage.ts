// Opens one owner-only buyer permission ledger; lifecycle owns the lock and never repairs unsafe files.
import { buyerApiKeyPathsIn, type HomeEnvironment } from '@gyblos/config/home';
import type { BuyerKeyScope } from '@gyblos/protocol/buyer-api-keys';
import {
  acquireProcessLock,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { createBuyerApiKeys } from './buyer-api-keys';
import { BUYER_API_KEY_STORAGE } from './constants';

export async function openBuyerApiKeys(
  environment: HomeEnvironment,
  scope: BuyerKeyScope,
) {
  const paths = buyerApiKeyPathsIn(environment);
  const lock = await acquireProcessLock(paths.lock);
  try {
    return await createBuyerApiKeys({
      scope,
      files: {
        read: () =>
          readPrivateFile(paths.state, BUYER_API_KEY_STORAGE.MAX_BYTES),
        write: async (text) => {
          await lock.verify();
          await writePrivateFile(
            paths.state,
            text,
            BUYER_API_KEY_STORAGE.MAX_BYTES,
          );
        },
        close: () => lock.release(),
      },
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
}
