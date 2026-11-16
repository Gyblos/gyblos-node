// Child-only entry: fixed synthetic cases, sanitized metadata report and lifecycle-bound shutdown.
import { isMain, onShutdown } from '@gyblos/runtime';

import { acceptanceAssert, acceptanceDiagnosticCode } from './errors';
import { TOOL_ACCEPTANCE, TOOL_ACCEPTANCE_CASES } from './tools-constants';
import { runToolCase } from './tools-diagnostics';

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
      JSON.stringify(
        await runToolCase(scenario, controller.signal, {
          sink: (diagnostic) => console.log(JSON.stringify({ diagnostic })),
        }),
      ),
    );
    return 0;
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        code: acceptanceDiagnosticCode(error),
      }),
    );
    return 1;
  } finally {
    dispose();
  }
}
if (isMain(import.meta.url)) process.exitCode = await main();
