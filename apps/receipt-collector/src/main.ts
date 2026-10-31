// Explicit standalone collector process; import does not open a file, listener or timer.
import { isMain, shutdownSignal } from '@gyblos/runtime';

import { LOCAL_COLLECTOR_CODES } from './constants';
import { LocalCollectorError } from './errors';
import { startLocalCollector } from './service';
import { loadCollectorSettings } from './settings';

export async function main() {
  let host: Awaited<ReturnType<typeof startLocalCollector>> | undefined;
  const shutdown = shutdownSignal();
  let outcome = 0;
  try {
    if (process.argv.slice(2).length || !process.env.GYBLOS_COLLECTOR_CONFIG)
      throw new LocalCollectorError(LOCAL_COLLECTOR_CODES.INVALID);
    host = await startLocalCollector(
      await loadCollectorSettings(process.env.GYBLOS_COLLECTOR_CONFIG),
    );
    console.log(JSON.stringify({ ok: true, loopback: true }));
    await shutdown.signalled;
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof LocalCollectorError
            ? error.code
            : LOCAL_COLLECTOR_CODES.STORAGE,
      }),
    );
    outcome = 1;
  } finally {
    try {
      await host?.close();
    } catch {
      outcome = 1;
      console.error(
        JSON.stringify({ ok: false, code: LOCAL_COLLECTOR_CODES.STORAGE }),
      );
    } finally {
      shutdown.dispose();
    }
  }
  return outcome;
}
if (isMain(import.meta.url)) process.exitCode = await main();
