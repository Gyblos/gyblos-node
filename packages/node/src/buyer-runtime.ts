// Exclusive lifetime ownership of a buyer home across financial modes; no key loading or chain access.
import { batchPoolPathsIn, type HomeEnvironment } from '@gyblos/config/home';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
} from '@gyblos/runtime/private-file';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';

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
  const lock = await ensurePrivateDirectory(paths.directory)
    .then(() => acquireProcessLock(paths.runtimeLock))
    .catch(() => {
      throw new NodeError(NODE_ERROR_CODES.BUYER_RUNTIME_UNAVAILABLE);
    });
  try {
    const host = await start();
    const close = host.close.bind(host);
    type Result = Awaited<
      ReturnType<NonNullable<BuyerRuntimeHost['inspectAndClose']>>
    >;
    let terminal: Promise<Result> | undefined;
    const finalize = (run: () => Promise<Result>) => {
      terminal ??= Promise.resolve()
        .then(run)
        .finally(() => lock.release());
      return terminal;
    };
    const inspect = host.inspectAndClose?.bind(host);
    return {
      ...host,
      close: async () => {
        await finalize(async () => {
          await close();
          return undefined;
        });
      },
      ...(inspect
        ? {
            inspectAndClose: (
              ...args: Parameters<
                NonNullable<BuyerRuntimeHost['inspectAndClose']>
              >
            ) => finalize(() => inspect(...args)),
          }
        : {}),
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
