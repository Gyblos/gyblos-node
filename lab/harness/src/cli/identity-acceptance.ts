// Runs only the isolated synthetic 8004/free acceptance scenario; accepts no operational arguments.
import { isMain, onShutdown } from '@gyblos/runtime';

import { ACCEPTANCE_CODES } from '../acceptance/constants';
import { AcceptanceError } from '../acceptance/errors';
import { runIdentityAcceptance } from '../acceptance/identity-run';

export async function main(
  args = process.argv.slice(2),
  dependencies: {
    write?: (value: string) => void;
    run?: typeof runIdentityAcceptance;
  } = {},
) {
  const write = dependencies.write ?? console.log;
  const controller = new AbortController();
  const dispose = onShutdown(() => controller.abort());
  try {
    if (args.length)
      throw new AcceptanceError(ACCEPTANCE_CODES.INVALID_OPTIONS);
    write(
      JSON.stringify(
        await (dependencies.run ?? runIdentityAcceptance)({
          signal: controller.signal,
        }),
      ),
    );
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
