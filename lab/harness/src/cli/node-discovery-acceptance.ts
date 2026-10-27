// Local acceptance CLI: no config/home/index overrides, no paid commands, sanitized JSON only.
// Imports are inert; native endpoints and any explicitly selected real engine are created inside main.
import { isMain, onShutdown } from '@gyblos/runtime';

import { ACCEPTANCE_CODES } from '../acceptance/constants';
import { AcceptanceError } from '../acceptance/errors';
import { parseAcceptanceArgs } from '../acceptance/options';
import { runNodeDiscoveryAcceptance } from '../acceptance/run';

export async function main(
  args = process.argv.slice(2),
  dependencies: {
    write?: (value: string) => void;
    run?: typeof runNodeDiscoveryAcceptance;
  } = {},
) {
  const write = dependencies.write ?? console.log;
  const controller = new AbortController();
  const dispose = onShutdown(() => controller.abort());
  try {
    const options = parseAcceptanceArgs(args);
    const report = await (dependencies.run ?? runNodeDiscoveryAcceptance)({
      ...options,
      signal: controller.signal,
    });
    write(JSON.stringify(report));
    return 0;
  } catch (error) {
    write(
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
if (isMain(import.meta.url)) process.exitCode = await main();
