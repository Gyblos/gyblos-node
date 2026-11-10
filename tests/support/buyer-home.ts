// A disposable buyer home for the paid buyer commands: the buyer role set up by `pnpm node:setup`
// for a mint, and a runner that points GYBLOS_HOME at it while capturing stderr and the exit code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPOSITORY_ROOT } from './node-config-fixtures';

export async function setupBuyer(home: string, mint: string) {
  const setup = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/node/src/bin.ts',
      'setup',
      '--role',
      'buyer',
      '--mint',
      mint,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        GYBLOS_HOME: home,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(setup.status, 0, setup.stderr);
  return (
    JSON.parse(await readFile(join(home, 'buyer', 'role.json'), 'utf8')) as {
      buyer: string;
    }
  ).buyer;
}

// Runs with this home, capturing stderr and the exit code, and restores the process afterwards.
export async function inHome<T>(
  home: string,
  run: (errors: string[]) => Promise<T>,
) {
  const saved = {
    home: process.env.GYBLOS_HOME,
    error: console.error,
    exitCode: process.exitCode,
  };
  const errors: string[] = [];
  process.env.GYBLOS_HOME = home;
  console.error = (line: string) => errors.push(line);
  process.exitCode = 0;
  try {
    return await run(errors);
  } finally {
    if (saved.home === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = saved.home;
    console.error = saved.error;
    process.exitCode = saved.exitCode;
  }
}
