import { parseArgs } from 'node:util';

import { desc, eq, isNotNull, or } from 'drizzle-orm';

import { isMain } from '@gyblos/runtime';

import { REGISTRATION } from '../src/constants';
import { sellerProfiles as table } from '../src/schema';
import { compileSql, wranglerD1 } from './wrangler-d1';

const MAX_ROWS = 1000;
const HELD = 1;
const OPEN = 0;
const USAGE =
  'usage: pnpm index:seller-profiles [--hold <NodeId> | --release <NodeId>] [--remote]\n';

export interface SellerProfilesIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  query: (sql: string, remote: boolean) => unknown[];
  execute: (sql: string, remote: boolean) => void;
  now: () => number;
}

export function sellerProfilesSql() {
  return compileSql((database) =>
    database
      .select({
        nodeId: table.nodeId,
        name: table.name,
        held: table.held,
        issuedAt: table.issuedAt,
      })
      .from(table)
      .where(or(isNotNull(table.name), eq(table.held, HELD)))
      .orderBy(desc(table.issuedAt))
      .limit(MAX_ROWS),
  );
}

export function holdSql(nodeId: string, now: number) {
  return compileSql((database) =>
    database
      .insert(table)
      .values({
        nodeId,
        name: null,
        issuedAt: now,
        signature: null,
        held: HELD,
      })
      .onConflictDoUpdate({
        target: table.nodeId,
        set: { name: null, signature: null, held: HELD },
      }),
  );
}

export function releaseSql(nodeId: string) {
  return compileSql((database) =>
    database.update(table).set({ held: OPEN }).where(eq(table.nodeId, nodeId)),
  );
}

const time = (value: unknown) =>
  typeof value === 'number' ? new Date(value).toISOString() : '-';
const cell = (value: unknown) =>
  typeof value === 'string' && value ? value : '-';

function list(io: SellerProfilesIo, remote: boolean) {
  const rows = io.query(sellerProfilesSql(), remote);
  io.stdout('node\tname\theld\tissuedAt\n');
  for (const row of rows) {
    const field = (key: string) =>
      row && typeof row === 'object' ? Reflect.get(row, key) : undefined;
    io.stdout(
      [
        cell(field('node_id')),
        cell(field('name')),
        field('held') === HELD ? 'yes' : 'no',
        time(field('issued_at')),
      ].join('\t') + '\n',
    );
  }
  io.stdout(`${rows.length} name(s)\n`);
  return 0;
}

function parse(argv: readonly string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        hold: { type: 'string' },
        release: { type: 'string' },
        remote: { type: 'boolean' },
      },
    });
    const target = values.hold ?? values.release;
    if (
      positionals.length > 0 ||
      (values.hold !== undefined && values.release !== undefined) ||
      (target !== undefined && !REGISTRATION.nodeId.test(target))
    )
      return undefined;
    return values;
  } catch {
    return undefined;
  }
}

export function runSellerProfiles(
  argv: readonly string[],
  io: SellerProfilesIo,
) {
  const values = parse(argv);
  if (!values) {
    io.stderr(USAGE);
    return 1;
  }
  const remote = values.remote === true;
  if (values.hold !== undefined) {
    io.execute(holdSql(values.hold, io.now()), remote);
    io.stdout(`Held: ${values.hold} shows no name until released.\n`);
    return 0;
  }
  if (values.release !== undefined) {
    io.execute(releaseSql(values.release), remote);
    io.stdout(`Released: ${values.release} may set a name again.\n`);
    return 0;
  }
  return list(io, remote);
}

function wranglerQuery(sql: string, remote: boolean): unknown[] {
  const output = wranglerD1(sql, {
    target: remote ? '--remote' : '--local',
    json: true,
  });
  const parsed: unknown = JSON.parse(output);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const results: unknown =
    first && typeof first === 'object'
      ? Reflect.get(first, 'results')
      : undefined;
  return Array.isArray(results) ? results : [];
}

if (isMain(import.meta.url))
  process.exitCode = runSellerProfiles(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    query: wranglerQuery,
    execute: (sql, remote) => {
      wranglerD1(sql, { target: remote ? '--remote' : '--local', json: false });
    },
    now: Date.now,
  });
