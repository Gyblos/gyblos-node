import { parseArgs } from 'node:util';

import { desc, eq, isNotNull, or } from 'drizzle-orm';

import { isMain } from '@gyblos/runtime';

import { REGISTRATION, SELLER_PROFILE } from '../src/constants';
import { sellerProfiles as table } from '../src/schema';
import {
  cellText,
  cellTime,
  compileSql,
  wranglerD1,
  wranglerQuery,
} from './wrangler-d1';

const HELD = SELLER_PROFILE.held;
const OPEN = SELLER_PROFILE.open;
const USAGE =
  'usage: pnpm index:seller-profiles [--remote]\n       pnpm index:seller-profiles --hold <NodeId> --local|--remote\n       pnpm index:seller-profiles --release <NodeId> --local|--remote\n';

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
      .limit(SELLER_PROFILE.maxListedRows),
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

function list(io: SellerProfilesIo, remote: boolean) {
  const rows = io.query(sellerProfilesSql(), remote);
  io.stdout('node\tname\theld\tissuedAt\n');
  for (const row of rows) {
    const field = (key: string) =>
      row && typeof row === 'object' ? Reflect.get(row, key) : undefined;
    io.stdout(
      [
        cellText(field('node_id')),
        cellText(field('name')),
        field('held') === HELD ? 'yes' : 'no',
        cellTime(field('issued_at')),
      ].join('\t') + '\n',
    );
  }
  io.stdout(
    rows.length >= SELLER_PROFILE.maxListedRows
      ? `${rows.length} name(s); the list stops at 1,000 rows\n`
      : `${rows.length} name(s)\n`,
  );
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
        local: { type: 'boolean' },
      },
    });
    const target = values.hold ?? values.release;
    const targets = [values.local, values.remote].filter(Boolean).length;
    if (
      positionals.length > 0 ||
      (target === undefined ? values.local === true : targets !== 1) ||
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
  const database = remote ? 'remote' : 'local';
  if (values.hold !== undefined) {
    io.execute(holdSql(values.hold, io.now()), remote);
    io.stdout(
      `Held in the ${database} database: ${values.hold} shows no name until released.\n`,
    );
    return 0;
  }
  if (values.release !== undefined) {
    io.execute(releaseSql(values.release), remote);
    io.stdout(
      `Released in the ${database} database: ${values.release} may set a name again.\n`,
    );
    return 0;
  }
  return list(io, remote);
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
