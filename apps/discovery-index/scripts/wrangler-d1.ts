// Owns what the operator scripts share: the pinned Wrangler, the D1 database name, compile-only Drizzle
// rendering (Wrangler takes SQL text, not bind parameters) and the one `wrangler d1 execute` call.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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

// Runs one SQL command through Wrangler. `target` is `--remote` or `--local`; with `json`, Wrangler's
// JSON output is returned, otherwise its stdout is discarded.
export function wranglerD1(
  sql: string,
  { target, json }: { target: '--remote' | '--local'; json: boolean },
): string {
  const output = execFileSync(
    'npx',
    [
      WRANGLER,
      'd1',
      'execute',
      DATABASE,
      target,
      ...(json ? ['--json'] : []),
      '--command',
      sql,
    ],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      stdio: ['ignore', json ? 'pipe' : 'ignore', 'inherit'],
      encoding: 'utf8',
    },
  );
  return output ?? '';
}
