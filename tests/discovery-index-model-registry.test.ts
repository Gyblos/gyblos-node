import assert from 'node:assert/strict';
import test from 'node:test';

import { MODEL_REGISTRY } from '@gyblos/discovery-index/constants';
import { createMemoryModelRegistry } from '@gyblos/discovery-index/model-registry';
import { runModelRegistry } from '@gyblos/discovery-index/model-registry-admin';
import { createD1ModelRegistry } from '@gyblos/discovery-index/model-registry-d1';
import { MODEL_CATEGORIES } from '@gyblos/protocol/model-categories';
import { MODEL_IDENTITY_SOURCE } from '@gyblos/protocol/model-family';

import { createSqliteD1, type SqliteD1 } from './support/d1-sqlite';
import { eachStorage, indexNode } from './support/discovery-index-fixture';

const NOW = 1_800_000_000_000;
const registry = createMemoryModelRegistry([
  {
    modelId: 'acme/mystery-7b',
    family: 'other',
    lab: 'Acme Labs',
    categories: ['coding', 'reasoning'],
  },
]);

eachStorage(
  'the catalog prefers a registry entry and lists categories for every model',
  async ({ publish, call }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1, {
      models: ['qwen3-0.6b', 'acme/mystery-7b', 'mystery-7b'],
    });
    assert.equal((await publish(catalog)).status, 201);
    assert.equal(
      (await publish(await seller.presence(2, catalog))).status,
      201,
    );
    const body = await (await call('/v1/models/catalog')).json();
    const byId = Object.fromEntries(
      body.models.map((row: { id: string }) => [row.id, row]),
    );
    assert.deepEqual(byId['acme/mystery-7b'], {
      id: 'acme/mystery-7b',
      sellers: 1,
      family: 'other',
      lab: 'Acme Labs',
      source: MODEL_IDENTITY_SOURCE.REGISTRY,
      categories: ['coding', 'reasoning'],
    });
    assert.deepEqual(
      [byId['qwen3-0.6b'].source, byId['qwen3-0.6b'].categories],
      [MODEL_IDENTITY_SOURCE.RULES, []],
    );
    assert.deepEqual(
      [byId['mystery-7b'].source, byId['mystery-7b'].categories],
      [MODEL_IDENTITY_SOURCE.FALLBACK, []],
    );
    const plain = await (await call('/v1/models')).json();
    for (const row of plain.models)
      assert.deepEqual(Object.keys(row), ['id', 'sellers']);
  },
  { modelRegistry: registry },
);

function admin(db: SqliteD1) {
  return (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const targets: string[] = [];
    const code = runModelRegistry(argv, {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      now: () => NOW,
      query: (sql, remote) => {
        targets.push(`query:${remote}`);
        return db.raw.prepare(sql).all();
      },
      execute: (sql, remote) => {
        targets.push(`execute:${remote}`);
        db.raw.exec(sql);
      },
    });
    return { code, out: out.join(''), err: err.join(''), targets };
  };
}

void test('the operator sets, lists and removes registry entries, and the D1 store reads them', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const run = admin(db);
  const set = run([
    '--set',
    'acme/mystery-7b',
    '--family',
    'other',
    '--lab',
    "Acme's Lab",
    '--categories',
    'reasoning,coding,coding',
    '--remote',
  ]);
  assert.equal(set.code, 0, set.err);
  assert.deepEqual(set.targets, ['execute:true']);
  assert.match(set.out, /remote database/);
  const store = createD1ModelRegistry(db);
  const many = Array.from({ length: 150 }, (_, index) => `m-${index}`);
  assert.deepEqual(await store.get([...many, 'acme/mystery-7b']), [
    {
      modelId: 'acme/mystery-7b',
      family: 'other',
      lab: "Acme's Lab",
      categories: ['coding', 'reasoning'],
    },
  ]);
  const listed = run([]);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.targets, ['query:false']);
  assert.ok(
    listed.out.includes(
      "acme/mystery-7b\tother\tAcme's Lab\tcoding,reasoning\t",
    ),
    listed.out,
  );
  const removed = run(['--remove', 'acme/mystery-7b', '--local']);
  assert.equal(removed.code, 0);
  assert.deepEqual(removed.targets, ['execute:false']);
  assert.deepEqual(await store.get(['acme/mystery-7b']), []);
});

void test('the operator script refuses unknown categories, families and malformed arguments', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const run = admin(db);
  const base = ['--set', 'acme/x', '--family', 'qwen', '--lab', 'Acme'];
  for (const argv of [
    [...base, '--categories', 'coding,poetry', '--local'],
    [...base, '--categories', '', '--local'],
    [
      '--set',
      'acme/x',
      '--family',
      'acme',
      '--lab',
      'A',
      '--categories',
      'coding',
      '--local',
    ],
    [...base, '--categories', 'coding'],
    [...base, '--categories', 'coding', '--local', '--remote'],
    [
      '--set',
      'acme/x',
      '--family',
      'qwen',
      '--lab',
      'x'.repeat(MODEL_REGISTRY.maxLabCharacters + 1),
      '--categories',
      'coding',
      '--local',
    ],
    [
      '--set',
      ' bad id',
      '--family',
      'qwen',
      '--lab',
      'A',
      '--categories',
      'coding',
      '--local',
    ],
    ['--remove', 'acme/x'],
    ['--unclassified', '--local'],
    ['stray'],
  ]) {
    const result = run(argv);
    assert.equal(result.code, 1, argv.join(' '));
    assert.match(result.err, /usage: pnpm index:models/);
    assert.deepEqual(result.targets, []);
  }
  assert.ok(MODEL_CATEGORIES.includes('document-understanding'));
});

void test('unclassified lists models in live catalogs without a registry entry and fails until none remain', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const node = (digit: string) => digit.repeat(64);
  const catalog = (nodeId: string, expiresAt: number, models: string[]) => {
    db.raw.exec(
      `insert into discovery_catalogs (node_id, owner, sequence, digest, issued_at, expires_at, signed_json) values ('${nodeId}', 'owner', 1, '${'0'.repeat(64)}', ${NOW - 1}, ${expiresAt}, '{}')`,
    );
    for (const model of models)
      db.raw.exec(
        `insert into discovery_catalog_models (node_id, model_id) values ('${nodeId}', '${model}')`,
      );
  };
  catalog(node('a'), NOW + 60_000, ['qwen3-0.6b', 'acme/new-1b']);
  catalog(node('b'), NOW - 1, ['expired/old']);
  const run = admin(db);
  const open = run(['--unclassified', '--remote']);
  assert.equal(open.code, 1);
  assert.deepEqual(open.targets, ['query:true']);
  assert.equal(open.out, 'acme/new-1b\nqwen3-0.6b\n2 unclassified model(s)\n');
  for (const id of ['acme/new-1b', 'qwen3-0.6b'])
    assert.equal(
      run([
        '--set',
        id,
        '--family',
        'qwen',
        '--lab',
        'Alibaba · Qwen',
        '--categories',
        'general',
        '--local',
      ]).code,
      0,
    );
  const done = run(['--unclassified']);
  assert.equal(done.code, 0);
  assert.equal(done.out, '0 unclassified model(s)\n');
});
