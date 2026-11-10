// Routes the one seller entry point (bin.ts) for every way the seller runs: `pnpm gyblos` from a checkout,
// the seller image's entrypoint and the packaged release's launcher. `start` runs the daemon, `setup`
// provisions the role, `tokenizer` prepares the pinned tokenizer and `--version` prints the release;
// everything else is the `gyblos` command.
import { main as cli } from './cli';
import { UPDATE } from './cli-update';
import { start } from './main';
import { main as setup } from './setup';
import { main as tokenizer } from './tokenizer';

export const ENTRY_COMMANDS = {
  START: 'start',
  SETUP: 'setup',
  TOKENIZER: 'tokenizer',
  VERSION: '--version',
} as const;

export async function run(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [command, ...rest] = args;
  switch (command) {
    case ENTRY_COMMANDS.START:
      return start();
    case ENTRY_COMMANDS.SETUP:
      return setup(rest);
    case ENTRY_COMMANDS.TOKENIZER:
      return tokenizer();
    case ENTRY_COMMANDS.VERSION:
      // Releases carry their version; a checkout has none.
      process.stdout.write(`${environment[UPDATE.versionEnv] || 'source'}\n`);
      return;
    default:
      return cli([...args]);
  }
}
