// Exclusive lifetime ownership of a buyer home across financial modes; no key loading or chain access.
import { batchPoolPathsIn, type HomeEnvironment } from '@gyblos/config/home';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
} from '@gyblos/runtime/private-file';

interface BuyerRuntimeHost {
  close(): Promise<void>;
  inspectAndClose?(
    digest: string,
    signal?: AbortSignal,
  ): Promise<{ chargedAtomic: string; refundedAtomic: string } | undefined>;
}
export async function withBuyerRuntime<Host extends BuyerRuntimeHost>(
  environment: HomeEnvironment,
  start: () => Promise<Host>,
): Promise<Host> {
  const paths = batchPoolPathsIn(environment);
  await ensurePrivateDirectory(paths.directory);
  const lock = await acquireProcessLock(paths.runtimeLock).catch(() =>
    sessionFail(SESSION_CODES.UNAVAILABLE),
  );
  try {
    const host = await start();
    const close = host.close.bind(host);
    host.close = async () => {
      try {
        await close();
      } finally {
        await lock.release();
      }
    };
    if (host.inspectAndClose) {
      const inspect = host.inspectAndClose.bind(host);
      host.inspectAndClose = async (...args) => {
        try {
          return await inspect(...args);
        } finally {
          await lock.release();
        }
      };
    }
    return host;
  } catch (error) {
    await lock.release();
    throw error;
  }
}
