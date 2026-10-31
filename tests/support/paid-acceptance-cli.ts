// Offline verification command; never accepts operational home, network, wallet or provider overrides.
import { ACCEPTANCE_CODES } from '@gyblos/lab-harness/acceptance/constants';
import { AcceptanceError } from '@gyblos/lab-harness/acceptance/errors';
import { isMain, onShutdown } from '@gyblos/runtime';

import type { PaidAcceptanceReport } from './paid-acceptance-constants';
import { runPaidAcceptance } from './paid-acceptance-run';

export async function main(
  args: string[],
  options: {
    write(value: string): void;
    run(signal: AbortSignal): Promise<PaidAcceptanceReport>;
  } = {
    write: (value) => console.log(value),
    run: (signal) => runPaidAcceptance({ signal }),
  },
) {
  if (args.length) {
    options.write(
      JSON.stringify({ ok: false, code: ACCEPTANCE_CODES.INVALID_OPTIONS }),
    );
    return 1;
  }
  const controller = new AbortController();
  const dispose = onShutdown(() => controller.abort());
  try {
    options.write(JSON.stringify(await options.run(controller.signal)));
    return 0;
  } catch (error) {
    options.write(
      JSON.stringify({
        ok: false,
        code:
          error instanceof AcceptanceError
            ? error.code
            : ACCEPTANCE_CODES.FAILED,
      }),
    );
    return 1;
  } finally {
    dispose();
  }
}
if (isMain(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
