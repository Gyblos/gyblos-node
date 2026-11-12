// Child-only entry: fixed synthetic cases, sanitized metadata report and lifecycle-bound shutdown.
import { isMain, onShutdown } from '@gyblos/runtime';

import { ACCEPTANCE_CODES } from './constants';
import { acceptanceAssert, AcceptanceError } from './errors';
import { TOOL_ACCEPTANCE, TOOL_ACCEPTANCE_CASES } from './tools-constants';
import { toolScenario } from './tools-scenario';

async function main() {
  const controller = new AbortController();
  const dispose = onShutdown(() => controller.abort());
  try {
    const scenario = Object.values(TOOL_ACCEPTANCE_CASES).find(
      (value) => value === process.argv[2],
    );
    acceptanceAssert(
      scenario && process.argv.length === TOOL_ACCEPTANCE.workerArgumentCount,
    );
    console.log(
      JSON.stringify(await toolScenario(scenario, controller.signal)),
    );
    return 0;
  } catch (error) {
    console.log(
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
