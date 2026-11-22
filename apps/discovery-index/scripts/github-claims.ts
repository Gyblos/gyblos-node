// Owns the read-only operator view of seller GitHub claims (`pnpm index:github-claims`): who started a
// claim and where it stands, from the local D1 (default) or the remote one (--remote). Drizzle compiles
// the query for Wrangler; nothing is written, and tombstones (cancelled claims) are left out.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { asc, desc, eq, isNotNull } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/sqlite-proxy';

import { isMain } from '@gyblos/runtime';

import { GITHUB_CLAIM_STATES, type GithubClaimState } from '../src/constants';
import * as schema from '../src/schema';

const WRANGLER = 'wrangler@4.151.1';
const DATABASE = 'gyblos-discovery';
// Rows listed at most; the newest claims first within each state.
const MAX_ROWS = 1000;
const USAGE =
  'usage: pnpm index:github-claims [--state pending|verified|lost] [--remote]\n';

export interface ClaimsIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Runs the read-only SQL against D1 and returns its rows; tests replace it.
  query: (sql: string, remote: boolean) => unknown[];
}

function stateOf(value: string | undefined): GithubClaimState | null {
  return (
    Object.values(GITHUB_CLAIM_STATES).find((state) => state === value) ?? null
  );
}

export function githubClaimsSql(state: GithubClaimState | undefined) {
  const database = drizzle(
    async () => {
      throw new TypeError('Admin queries must be compiled before execution.');
    },
    { schema },
  );
  const table = schema.githubClaims;
  const query = database
    .select({
      nodeId: table.nodeId,
      account: table.account,
      gist: table.gist,
      state: table.state,
      reason: table.reason,
      issuedAt: table.issuedAt,
      checkedAt: table.checkedAt,
    })
    .from(table)
    .where(state ? eq(table.state, state) : isNotNull(table.state))
    .orderBy(asc(table.state), desc(table.issuedAt))
    .limit(MAX_ROWS);
  return new SQLiteSyncDialect().sqlToQuery(query.getSQL().inlineParams()).sql;
}

const time = (value: unknown) =>
  typeof value === 'number' ? new Date(value).toISOString() : '-';
const cell = (value: unknown) =>
  typeof value === 'string' && value ? value : '-';

export function runGithubClaims(argv: readonly string[], io: ClaimsIo) {
  let values: { state?: string; remote?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { state: { type: 'string' }, remote: { type: 'boolean' } },
    }));
  } catch {
    io.stderr(USAGE);
    return 1;
  }
  const state = stateOf(values.state);
  if (values.state !== undefined && !state) {
    io.stderr(USAGE);
    return 1;
  }
  const rows = io.query(githubClaimsSql(state ?? undefined), !!values.remote);
  io.stdout('node\taccount\tgist\tstate\treason\tissuedAt\tcheckedAt\n');
  for (const row of rows) {
    // Wrangler returns the SQL column names.
    const field = (key: string) =>
      row && typeof row === 'object' ? Reflect.get(row, key) : undefined;
    io.stdout(
      [
        cell(field('node_id')),
        cell(field('account')),
        cell(field('gist')),
        cell(field('state')),
        cell(field('reason')),
        time(field('issued_at')),
        time(field('checked_at')),
      ].join('\t') + '\n',
    );
  }
  io.stdout(`${rows.length} claim(s)\n`);
  return 0;
}

// `wrangler d1 execute --json` prints one result set per statement.
function wranglerQuery(sql: string, remote: boolean): unknown[] {
  const output = execFileSync(
    'npx',
    [
      WRANGLER,
      'd1',
      'execute',
      DATABASE,
      remote ? '--remote' : '--local',
      '--json',
      '--command',
      sql,
    ],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    },
  );
  const parsed: unknown = JSON.parse(output);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const results: unknown =
    first && typeof first === 'object'
      ? Reflect.get(first, 'results')
      : undefined;
  return Array.isArray(results) ? results : [];
}

if (isMain(import.meta.url))
  process.exitCode = runGithubClaims(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    query: wranglerQuery,
  });
