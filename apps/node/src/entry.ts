// Routes the one seller entry point (bin.ts) for every way the seller runs: `pnpm gyblos` from a checkout,
// the seller image's entrypoint and the packaged release's launcher. `start` runs the daemon, `setup`
// provisions the role, `tokenizer` prepares the pinned tokenizer, `service-run` supervises the daemon for
// the Windows service and `--version` prints the release;
// everything else is the `gyblos` command.
import { UPDATE } from './cli-update';

export const ENTRY_COMMANDS = {
  START: 'start',
  SETUP: 'setup',
  TOKENIZER: 'tokenizer',
  VERSION: '--version',
  // The Windows service's supervisor; the scheduled task runs it, not the seller.
  SERVICE_RUN: 'service-run',
} as const;

async function usage(args: readonly string[]) {
  return (await import('./cli')).main([...args]);
}

export async function run(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [command, ...rest] = args;
  switch (command) {
    // Each command loads only its own modules, so the long-running daemon never loads the CLI.
    case ENTRY_COMMANDS.START:
      if (rest.length) return usage(args);
      return (await import('./daemon')).start();
    case ENTRY_COMMANDS.SETUP:
      return (await import('./setup')).main(rest);
    case ENTRY_COMMANDS.TOKENIZER:
      if (rest.length) return usage(args);
      return (await import('./tokenizer')).main();
    case ENTRY_COMMANDS.SERVICE_RUN:
      process.exitCode = await (await import('./service-run')).serviceRun(rest);
      return;
    case ENTRY_COMMANDS.VERSION:
      if (rest.length) return usage(args);
      // Releases carry their version; a checkout has none.
      process.stdout.write(`${environment[UPDATE.versionEnv] || 'source'}\n`);
      return;
    default:
      return usage(args);
  }
}
