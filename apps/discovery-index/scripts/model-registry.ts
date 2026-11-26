import { parseArgs } from 'node:util';

import { asc, eq } from 'drizzle-orm';

import { controlIdentifier } from '@gyblos/protocol/control-validation';
import {
  isModelCategory,
  sortedCategories,
} from '@gyblos/protocol/model-categories';
import { isMain } from '@gyblos/runtime';

import { MODEL_REGISTRY } from '../src/constants';
import { isRegistryFamily, storedEntry } from '../src/model-registry';
import { modelRegistry as table } from '../src/schema';
import { modelsQuery } from '../src/storage-queries';
import {
  cellText,
  cellTime,
  compileSql,
  wranglerD1,
  wranglerQuery,
} from './wrangler-d1';

const USAGE =
  'usage: pnpm index:models [--remote]\n       pnpm index:models --unclassified [--remote]\n       pnpm index:models --set <model> --family <family> --lab <lab> --categories <a,b> --local|--remote\n       pnpm index:models --remove <model> --local|--remote\n';
const D1_FAILED = 'The model registry command could not reach D1.\n';
const { exitPending, exitFailure } = MODEL_REGISTRY;

export interface ModelRegistryIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  query: (sql: string, remote: boolean) => unknown[];
  execute: (sql: string, remote: boolean) => void;
  now: () => number;
}

interface SetEntry {
  modelId: string;
  family: string;
  lab: string;
  categories: string[];
}

export const registrySql = () =>
  compileSql((database) =>
    database
      .select()
      .from(table)
      .orderBy(asc(table.modelId))
      .limit(MODEL_REGISTRY.maxListedRows),
  );

export const setSql = (entry: SetEntry, now: number) =>
  compileSql((database) => {
    const values = {
      family: entry.family,
      lab: entry.lab,
      categories: JSON.stringify(entry.categories),
      updatedAt: now,
    };
    return database
      .insert(table)
      .values({ modelId: entry.modelId, ...values })
      .onConflictDoUpdate({ target: table.modelId, set: values });
  });

export const removeSql = (modelId: string) =>
  compileSql((database) =>
    database.delete(table).where(eq(table.modelId, modelId)),
  );

export const unclassifiedSql = (now: number) =>
  compileSql((database) => {
    const live = modelsQuery(database, now, MODEL_REGISTRY.maxListedRows).as(
      'live',
    );
    return database
      .select({
        modelId: live.modelId,
        family: table.family,
        lab: table.lab,
        categories: table.categories,
      })
      .from(live)
      .leftJoin(table, eq(table.modelId, live.modelId))
      .orderBy(asc(live.modelId));
  });

const field = (row: unknown, key: string) =>
  row && typeof row === 'object' ? Reflect.get(row, key) : undefined;

function categoryList(json: unknown) {
  try {
    const parsed = JSON.parse(cellText(json)) as unknown;
    return Array.isArray(parsed) ? parsed.join(',') : '';
  } catch {
    return '';
  }
}

function list(io: ModelRegistryIo, remote: boolean) {
  const rows = io.query(registrySql(), remote);
  io.stdout('model\tfamily\tlab\tcategories\tupdatedAt\n');
  for (const row of rows)
    io.stdout(
      [
        cellText(field(row, 'model_id')),
        cellText(field(row, 'family')),
        cellText(field(row, 'lab')),
        categoryList(field(row, 'categories_json')),
        cellTime(field(row, 'updated_at')),
      ].join('\t') + '\n',
    );
  io.stdout(
    rows.length >= MODEL_REGISTRY.maxListedRows
      ? `${rows.length} model(s); the list stops at 1,000 rows\n`
      : `${rows.length} model(s)\n`,
  );
  return 0;
}

function unclassified(io: ModelRegistryIo, remote: boolean) {
  const live = io.query(unclassifiedSql(io.now()), remote);
  const pending = live.filter(
    (row) =>
      storedEntry(
        field(row, 'model_id'),
        field(row, 'family'),
        field(row, 'lab'),
        field(row, 'categories_json'),
      ).length === 0,
  );
  for (const row of pending) io.stdout(`${cellText(field(row, 'model_id'))}\n`);
  io.stdout(
    live.length >= MODEL_REGISTRY.maxListedRows
      ? `${pending.length} unclassified model(s); the check stops at 1,000 live models\n`
      : `${pending.length} unclassified model(s)\n`,
  );
  return pending.length ? exitPending : 0;
}

function validId(value: string | undefined) {
  if (value === undefined) return true;
  try {
    return controlIdentifier(value) === value;
  } catch {
    return false;
  }
}

const categoriesOf = (value: unknown) =>
  typeof value === 'string'
    ? value.split(',').map((category) => category.trim())
    : [];

function validSet(values: Record<string, string | boolean | undefined>) {
  const categories = categoriesOf(values.categories);
  const lab = typeof values.lab === 'string' ? values.lab : '';
  return (
    isRegistryFamily(values.family) &&
    lab.length > 0 &&
    lab.length <= MODEL_REGISTRY.maxLabCharacters &&
    lab === lab.trim() &&
    !MODEL_REGISTRY.unsafeLab.test(lab) &&
    categories.length > 0 &&
    categories.every(isModelCategory)
  );
}

function parse(argv: readonly string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        set: { type: 'string' },
        remove: { type: 'string' },
        family: { type: 'string' },
        lab: { type: 'string' },
        categories: { type: 'string' },
        unclassified: { type: 'boolean' },
        remote: { type: 'boolean' },
        local: { type: 'boolean' },
      },
    });
    const target = values.set ?? values.remove;
    const targets = [values.local, values.remote].filter(Boolean).length;
    const writes = target === undefined ? values.local !== true : targets === 1;
    const details = [values.family, values.lab, values.categories];
    if (
      positionals.length > 0 ||
      !writes ||
      (values.set !== undefined && values.remove !== undefined) ||
      (values.unclassified && target !== undefined) ||
      !validId(target) ||
      (values.set === undefined
        ? details.some((detail) => detail !== undefined)
        : !validSet(values))
    )
      return undefined;
    return values;
  } catch {
    return undefined;
  }
}

function write(
  io: ModelRegistryIo,
  values: NonNullable<ReturnType<typeof parse>>,
) {
  const remote = values.remote === true;
  const database = remote ? 'remote' : 'local';
  if (values.set !== undefined) {
    const entry = {
      modelId: values.set,
      family: values.family ?? '',
      lab: values.lab ?? '',
      categories: sortedCategories(categoriesOf(values.categories)),
    };
    io.execute(setSql(entry, io.now()), remote);
    io.stdout(`Set in the ${database} database: ${entry.modelId}.\n`);
    return 0;
  }
  io.execute(removeSql(values.remove ?? ''), remote);
  io.stdout(`Removed from the ${database} database: ${values.remove}.\n`);
  return 0;
}

export function runModelRegistry(argv: readonly string[], io: ModelRegistryIo) {
  const values = parse(argv);
  if (!values) {
    io.stderr(USAGE);
    return exitFailure;
  }
  try {
    if (values.set !== undefined || values.remove !== undefined)
      return write(io, values);
    const remote = values.remote === true;
    return values.unclassified ? unclassified(io, remote) : list(io, remote);
  } catch {
    io.stderr(D1_FAILED);
    return exitFailure;
  }
}

if (isMain(import.meta.url))
  process.exitCode = runModelRegistry(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    query: wranglerQuery,
    execute: (sql, remote) => {
      wranglerD1(sql, { target: remote ? '--remote' : '--local', json: false });
    },
    now: Date.now,
  });
