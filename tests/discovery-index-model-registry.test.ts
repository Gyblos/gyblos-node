import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import {
  MODEL_REGISTRY,
  PUBLISH_MODES,
} from '@gyblos/discovery-index/constants';
import type { ModelRegistryStore } from '@gyblos/discovery-index/model-registry';
import { runModelRegistry } from '@gyblos/discovery-index/model-registry-admin';
import { createD1ModelRegistry } from '@gyblos/discovery-index/model-registry-d1';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { MODEL_CATEGORIES } from '@gyblos/protocol/constants';
import { MODEL_IDENTITY_SOURCE } from '@gyblos/protocol/model-family';

import { createSqliteD1, type SqliteD1 } from './support/d1-sqlite';
import {
  allLimiters,
  eachStorage,
  INDEX_ORIGIN,
  indexNode,
  T0,
} from './support/discovery-index-fixture';
import { createMemoryModelRegistry } from './support/model-registry-fixture';

const NOW = T0 + 1000;
const registry = createMemoryModelRegistry([
  {
    modelId: 'acme/mystery-7b',
    family: 'other',
    lab: 'Acme Labs',
    categories: ['coding', 'reasoning'],
  },
  {
    modelId: 'qwen3-0.6b',
    family: 'qwen',
    lab: 'Qwen Team',
    categories: ['general'],
  },
]);
const failing: ModelRegistryStore = {
  get: () => Promise.reject(new Error('no such table')),
};

async function publishCatalog(
  call: (path: string, init?: RequestInit) => Response | Promise<Response>,
  models: string[],
  presence = true,
) {
  const seller = indexNode();
  const catalog = seller.catalog(1, { models, issuedAt: NOW });
  const post = (record: unknown) =>
    call('/v1/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record }),
    });
  assert.equal((await post(catalog)).status, 201);
  if (presence)
    assert.equal(
      (await post(await seller.presence(2, catalog, { issuedAt: NOW }))).status,
      201,
    );
}

eachStorage(
  'a registry entry wins over the rules and every model lists its categories',
  async ({ publish, call }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1, {
      models: ['qwen3-0.6b', 'acme/mystery-7b', 'mystery-7b', 'meta-llama/x'],
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
    assert.deepEqual(byId['qwen3-0.6b'], {
      id: 'qwen3-0.6b',
      sellers: 1,
      family: 'qwen',
      lab: 'Qwen Team',
      source: MODEL_IDENTITY_SOURCE.REGISTRY,
      categories: ['general'],
    });
    assert.deepEqual(
      [byId['meta-llama/x'].source, byId['meta-llama/x'].categories],
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

eachStorage(
  'the catalog still answers from the rules when the registry cannot be read',
  async ({ publish, call }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1, { models: ['qwen3-0.6b'] });
    assert.equal((await publish(catalog)).status, 201);
    assert.equal(
      (await publish(await seller.presence(2, catalog))).status,
      201,
    );
    const response = await call('/v1/models/catalog');
    assert.equal(response.status, 200);
    const [model] = (await response.json()).models;
    assert.deepEqual(
      [model.source, model.lab, model.categories],
      [MODEL_IDENTITY_SOURCE.RULES, 'Alibaba · Qwen', []],
    );
  },
  { modelRegistry: failing },
);

void test('the category list is the documented taxonomy', () => {
  assert.deepEqual(MODEL_CATEGORIES, [
    'general',
    'coding',
    'agentic',
    'reasoning',
    'classification',
    'extraction',
    'embedding',
    'reranking',
    'vision',
    'speech-to-text',
    'text-to-speech',
    'translation',
    'moderation',
    'image-generation',
    'image-editing',
    'image-upscaling',
    'video-generation',
    'audio-generation',
    'document-understanding',
  ]);
});

function admin(db: SqliteD1, query?: () => never) {
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
        return query ? query() : db.raw.prepare(sql).all();
      },
      execute: (sql, remote) => {
        targets.push(`execute:${remote}`);
        db.raw.exec(sql);
      },
    });
    return { code, out: out.join(''), err: err.join(''), targets };
  };
}

void test('the operator sets, lists and removes entries, and the D1 store reads them in one bound value', async (context) => {
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
    'reasoning, coding,coding',
    '--remote',
  ]);
  assert.equal(set.code, 0, set.err);
  assert.deepEqual(set.targets, ['execute:true']);
  assert.match(set.out, /remote database/);
  let bound = 0;
  const store = createD1ModelRegistry({
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        ...statement,
        bind: (...values) => {
          bound = Math.max(bound, values.length);
          return statement.bind(...values);
        },
      };
    },
    batch: (statements) => db.batch(statements),
  });
  const many = Array.from({ length: 150 }, (_, index) => `m-${index}`);
  assert.deepEqual(await store.get([...many, 'acme/mystery-7b']), [
    {
      modelId: 'acme/mystery-7b',
      family: 'other',
      lab: "Acme's Lab",
      categories: ['coding', 'reasoning'],
    },
  ]);
  assert.equal(bound, 1);
  const listed = run([]);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.targets, ['query:false']);
  assert.ok(
    listed.out.includes(
      "acme/mystery-7b\tother\tAcme's Lab\tcoding,reasoning\t",
    ),
    listed.out,
  );
  assert.match(listed.out, /1 model\(s\)\n$/);
  const removed = run(['--remove', 'acme/mystery-7b', '--local']);
  assert.equal(removed.code, 0);
  assert.deepEqual(removed.targets, ['execute:false']);
  assert.deepEqual(await store.get(['acme/mystery-7b']), []);
});

void test('a stored row outside the taxonomy is skipped, not fatal', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const insert = (id: string, family: string, categories: string) =>
    db.raw.exec(
      `insert into discovery_model_registry (model_id, family, lab, categories_json, updated_at) values ('${id}', '${family}', 'Lab', '${categories}', 1)`,
    );
  insert('a/good', 'qwen', '["general"]');
  insert('b/bad-category', 'qwen', '["poetry"]');
  insert('c/bad-family', 'acme', '["general"]');
  const store = createD1ModelRegistry(db);
  assert.deepEqual(
    (await store.get(['a/good', 'b/bad-category', 'c/bad-family'])).map(
      (entry) => entry.modelId,
    ),
    ['a/good'],
  );
});

void test('the operator script refuses bad input with exit code 2 and touches nothing', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const run = admin(db);
  const set = (...rest: string[]) => ['--set', 'acme/x', ...rest];
  const ok = ['--family', 'qwen', '--lab', 'Acme', '--categories', 'coding'];
  for (const argv of [
    set(
      '--family',
      'qwen',
      '--lab',
      'Acme',
      '--categories',
      'coding,poetry',
      '--local',
    ),
    set('--family', 'qwen', '--lab', 'Acme', '--categories', '', '--local'),
    set(
      '--family',
      'qwen',
      '--lab',
      'Acme',
      '--categories',
      'coding,',
      '--local',
    ),
    set('--family', 'acme', '--lab', 'A', '--categories', 'coding', '--local'),
    set(...ok),
    set(...ok, '--local', '--remote'),
    set(
      '--family',
      'qwen',
      '--lab',
      'x'.repeat(MODEL_REGISTRY.maxLabCharacters + 1),
      '--categories',
      'coding',
      '--local',
    ),
    set('--family', 'qwen', '--lab', ' ', '--categories', 'coding', '--local'),
    set(
      '--family',
      'qwen',
      '--lab',
      ' Acme',
      '--categories',
      'coding',
      '--local',
    ),
    set(
      '--family',
      'qwen',
      '--lab',
      'Ac\tme',
      '--categories',
      'coding',
      '--local',
    ),
    ['--set', ' bad id', ...ok, '--local'],
    [
      '--set',
      'a'.repeat(MODEL_REGISTRY.maxModelIdCharacters + 1),
      ...ok,
      '--local',
    ],
    [...set(...ok, '--local'), '--remove', 'acme/x'],
    ['--unclassified', ...set(...ok, '--local')],
    ['--family', 'qwen'],
    ['--remove', 'acme/x'],
    ['--unclassified', '--local'],
    ['stray'],
  ]) {
    const result = run(argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.match(result.err, /usage: pnpm index:models/);
    assert.deepEqual(result.targets, []);
  }
  const broken = admin(db, () => {
    throw new Error('wrangler failed');
  })(['--unclassified', '--remote']);
  assert.equal(broken.code, 2);
  assert.equal(broken.err, 'The model registry check could not read D1.\n');
});

void test('unclassified lists the live catalog models without an entry and exits 1 until none remain', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const app = createDiscoveryIndex({
    storage: createD1Storage(db),
    limiters: allLimiters(),
    now: () => NOW,
    publishers: { mode: PUBLISH_MODES.OPEN },
  });
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(INDEX_ORIGIN + path, init));
  await publishCatalog(call, ['qwen3-0.6b', 'acme/new-1b']);
  await publishCatalog(call, ['acme/new-1b']);
  await publishCatalog(call, ['offline/only'], false);
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
