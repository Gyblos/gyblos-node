// Owns what the operator scripts share: the pinned Wrangler, the D1 database name, compile-only Drizzle
// rendering (Wrangler takes SQL text, not bind parameters) and the one `wrangler d1 execute` call.
import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SQLWrapper } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/sqlite-proxy';

import type { DiscoveryDatabase } from '../src/d1-client';
import * as schema from '../src/schema';

const WRANGLER = 'wrangler@4.151.1';
const DATABASE = 'gyblos-discovery';

// Drizzle's dialect safely renders its bound values; this compilation-only client fails if a query is
// accidentally executed here.
export function compileSql(build: (database: DiscoveryDatabase) => SQLWrapper) {
  const database = drizzle(
    async () => {
      throw new TypeError('Admin queries must be compiled before execution.');
    },
    { schema },
  );
  return new SQLiteSyncDialect().sqlToQuery(
    build(database).getSQL().inlineParams(),
  ).sql;
}

// npm's npx script beside this Node binary, run by that binary: the same on every platform, with no shell
// (SQL never meets a command interpreter) and no npx.cmd, which Node does not spawn without one. Node's
// installers and version managers place npm at node_modules/npm next to node.exe on Windows and at
// lib/node_modules/npm under the prefix elsewhere; macOS and Linux fall back to npx on PATH.
export function wranglerLaunch(
  platform: NodeJS.Platform,
  execPath: string,
  args: readonly string[],
  exists: (path: string) => boolean = existsSync,
) {
  const paths = platform === 'win32' ? win32 : posix;
  const bin = paths.dirname(execPath);
  const npx =
    platform === 'win32'
      ? paths.join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js')
      : paths.join(
          bin,
          '..',
          'lib',
          'node_modules',
          'npm',
          'bin',
          'npx-cli.js',
        );
  if (exists(npx)) return { file: execPath, args: [npx, WRANGLER, ...args] };
  // macOS and Linux run a PATH npx directly (execFile, no shell); Windows has only npx.cmd, which Node does
  // not spawn without a shell, so it needs npm beside node.exe.
  if (platform !== 'win32') return { file: 'npx', args: [WRANGLER, ...args] };
  throw new Error(
    "npm's npx was not found next to this Node.js; install Node.js with npm.",
  );
}

// Runs a program and returns its stdout; tests replace it.
export type RunProgram = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string | null;

// Runs one SQL command through Wrangler. `target` is `--remote` or `--local`; with `json`, Wrangler's
// JSON output is returned, otherwise its stdout is discarded. A failed launch or run throws a static
// error: Node's own error repeats the whole command line, SQL values (such as an invite's contact)
// included. Wrangler's own messages still reach this terminal and may quote the statement.
export function wranglerD1(
  sql: string,
  { target, json }: { target: '--remote' | '--local'; json: boolean },
  run: RunProgram = (file, args, options) =>
    execFileSync(file, [...args], options),
): string {
  const launch = wranglerLaunch(process.platform, process.execPath, [
    'd1',
    'execute',
    DATABASE,
    target,
    ...(json ? ['--json'] : []),
    '--command',
    sql,
  ]);
  try {
    return (
      run(launch.file, launch.args, {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        stdio: ['ignore', json ? 'pipe' : 'ignore', 'inherit'],
        encoding: 'utf8',
      }) ?? ''
    );
  } catch {
    throw new Error('Wrangler could not run the D1 command.');
  }
}
