// Owns what the operator scripts share: the pinned Wrangler, the D1 database name, compile-only Drizzle
// rendering (Wrangler takes SQL text, not bind parameters) and the one `wrangler d1 execute` call.
import { execFileSync } from 'node:child_process';
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
// lib/node_modules/npm under the prefix elsewhere.
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
  if (!exists(npx))
    throw new Error(
      "npm's npx was not found next to this Node.js; install Node.js with npm.",
    );
  return { file: execPath, args: [npx, WRANGLER, ...args] };
}

// Runs one SQL command through Wrangler. `target` is `--remote` or `--local`; with `json`, Wrangler's
// JSON output is returned, otherwise its stdout is discarded.
export function wranglerD1(
  sql: string,
  { target, json }: { target: '--remote' | '--local'; json: boolean },
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
  const output = execFileSync(launch.file, launch.args, {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    stdio: ['ignore', json ? 'pipe' : 'ignore', 'inherit'],
    encoding: 'utf8',
  });
  return output ?? '';
}
