// Protects the D1 storage cost model of the discovery index: the two-phase listing plan, diff-based
// model writes, in-place upserts, identical listings across adapters and the node cap check.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import {
  NODE_PUBLISH_QUOTA,
  PUBLISH_MODES,
} from '@gyblos/discovery-index/constants';
import type { DiscoveryPublishers } from '@gyblos/discovery-index/publishers';
import {
  createMemoryStorage,
  type DiscoveryStorage,
  type SellerCursor,
  type SellerQuery,
  type SellerRow,
  type StoredEntry,
} from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import {
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';

import {
  createSqliteD1,
  explainD1Statement,
  type SqliteD1,
  type SqliteQueryPlanRow,
  type SqliteStatement,
} from './support/d1-sqlite';
import {
  allLimiters,
  CLIENT_IP,
  INDEX_ORIGIN,
  INDEX_OWNER,
  indexNode,
  T0,
} from './support/discovery-index-fixture';

const hex = (seed: number) => seed.toString(16).padStart(64, '0');

interface Written {
  sql: string;
  params: SqliteStatement['params'];
  changes: number;
}

// A sqlite D1 whose batches record each statement with its row changes and whose prepared
// reads record their SQL and parameters.
async function recordingD1() {
  const db = await createSqliteD1();
  if (!db) return null;
  const written: Written[] = [];
  const read: SqliteStatement[] = [];
  const wrapped: SqliteD1 = {
    ...db,
    prepare: (sql) => {
      const statement = db.prepare(sql);
      const record = (bound: SqliteStatement): SqliteStatement => ({
        ...bound,
        bind: (...values) => record(bound.bind(...values) as SqliteStatement),
        all: () => {
          read.push(bound);
          return bound.all();
        },
      });
      return record(statement);
    },
    batch: async (statements) => {
      for (const statement of statements) {
        assert.ok('params' in statement && Array.isArray(statement.params));
        assert.ok(
          statement.params.length <= 100,
          'D1 accepts at most 100 parameters per statement',
        );
      }
      const results = await db.batch(statements);
      statements.forEach((statement, index) =>
        written.push({
          sql: (statement as SqliteStatement).sql,
          params: (statement as SqliteStatement).params,
          changes: results[index]?.meta.changes ?? 0,
        }),
      );
      return results;
    },
  };
  return { db, written, read, storage: createD1Storage(wrapped) };
}

function entry(
  kind: StoredEntry['kind'],
  nodeId: string,
  sequence: number,
  overrides: Partial<StoredEntry> = {},
): StoredEntry {
  return {
    admission: {
      now: T0,
      maxNodes: 10_000,
      maxPublications: NODE_PUBLISH_QUOTA.limit,
    },
    kind,
    nodeId,
    owner: INDEX_OWNER,
    sequence,
    issuedAt: T0,
    expiresAt: T0 + 90_000,
    digest: 'd'.repeat(64),
    models: [],
    signature: `sig-${sequence}`,
    retainUntil: T0 + 1_200_000,
    json: `{"kind":"${kind}","sequence":${sequence}}`,
    ...overrides,
  };
}

const modelChanges = (written: Written[]) =>
  written
    .filter((item) => item.sql.includes('discovery_catalog_models'))
    .reduce((total, item) => total + item.changes, 0);

void test('D1 catalog republish writes only the model rows that changed', async (context) => {
  const made = await recordingD1();
  if (!made) return context.skip('node:sqlite unavailable');
  const { db, written, storage } = made;
  const node = hex(1);
  const models = () =>
    db.raw
      .prepare(
        'SELECT model_id AS m FROM discovery_catalog_models WHERE node_id = ? ORDER BY m',
      )
      .all(node)
      .map((row) => String(row.m));
  const catalog = (sequence: number, list: string[]) =>
    entry(PUBLIC_RECORD_KINDS.CATALOG, node, sequence, { models: list });
  assert.equal(await storage.put(catalog(1, ['a', 'b', 'c'])), true);
  assert.equal(modelChanges(written), 3);
  written.length = 0;
  assert.equal(await storage.put(catalog(2, ['c', 'a', 'b'])), true);
  assert.equal(modelChanges(written), 0);
  assert.deepEqual(models(), ['a', 'b', 'c']);
  written.length = 0;
  assert.equal(await storage.put(catalog(3, ['b', 'c', 'd'])), true);
  assert.equal(modelChanges(written), 2);
  assert.deepEqual(models(), ['b', 'c', 'd']);
  // A stale catalog changes nothing, models included. (The guard matches sequence and
  // signature, so a stale record differs in its signature, as a real one would.)
  written.length = 0;
  assert.equal(
    await storage.put({ ...catalog(3, ['x']), signature: 'other' }),
    false,
  );
  assert.equal(await storage.put(catalog(2, ['y'])), false);
  assert.equal(modelChanges(written), 0);
  assert.deepEqual(models(), ['b', 'c', 'd']);
  // Other NodeIds keep their models.
  await storage.put(
    entry(PUBLIC_RECORD_KINDS.CATALOG, hex(2), 1, { models: ['b'] }),
  );
  const full = Array.from(
    { length: PUBLIC_RECORD_LIMITS.maxModels },
    (_, index) => `model-${String(index).padStart(2, '0')}`,
  );
  written.length = 0;
  await storage.put(catalog(4, full));
  assert.deepEqual(models(), full);
  const modelInsert = written.find(({ sql }) =>
    /\binsert\s+into\s+"?discovery_catalog_models\b/i.test(sql),
  );
  assert.ok(modelInsert);
  const plan = explainD1Statement(db, modelInsert);
  assert.equal(
    plan.filter(({ detail }) =>
      /\b(?:SEARCH|SCAN) discovery_nodes\b/.test(detail),
    ).length,
    1,
    plan.map(({ detail }) => detail).join('\n'),
  );
  written.length = 0;
  await storage.put(catalog(5, [...full].reverse()));
  assert.equal(modelChanges(written), 0);
  await storage.put(catalog(6, []));
  assert.deepEqual(models(), []);
  assert.equal(
    db.raw.prepare('SELECT count(*) AS n FROM discovery_catalog_models').get()
      ?.n,
    1,
  );
});

void test('D1 record writes update rows in place instead of delete and reinsert', async (context) => {
  const made = await recordingD1();
  if (!made) return context.skip('node:sqlite unavailable');
  const { db, storage } = made;
  // With recursive triggers on, REPLACE conflict deletes fire delete triggers.
  db.raw.exec(`PRAGMA recursive_triggers = ON;
CREATE TEMP TABLE deleted (name TEXT NOT NULL);
CREATE TEMP TRIGGER presence_deleted AFTER DELETE ON discovery_presence BEGIN INSERT INTO deleted VALUES ('presence'); END;
CREATE TEMP TRIGGER catalog_deleted AFTER DELETE ON discovery_catalogs BEGIN INSERT INTO deleted VALUES ('catalog'); END;
CREATE TEMP TRIGGER withdrawal_deleted AFTER DELETE ON discovery_withdrawals BEGIN INSERT INTO deleted VALUES ('withdrawal'); END;`);
  const deleted = () =>
    db.raw
      .prepare('SELECT name FROM deleted')
      .all()
      .map((row) => String(row.name));
  const node = hex(7);
  const presenceRow = () =>
    db.raw
      .prepare(
        'SELECT sequence, issued_at AS issuedAt, expires_at AS expiresAt, catalog_digest AS digest, signed_json AS json FROM discovery_presence WHERE node_id = ?',
      )
      .get(node);
  await storage.put(
    entry(PUBLIC_RECORD_KINDS.CATALOG, node, 1, { models: ['m'] }),
  );
  await storage.put(entry(PUBLIC_RECORD_KINDS.PRESENCE, node, 2));
  assert.equal(
    await storage.put(
      entry(PUBLIC_RECORD_KINDS.PRESENCE, node, 3, {
        issuedAt: T0 + 5,
        expiresAt: T0 + 60_000,
        digest: 'd'.repeat(64),
      }),
    ),
    true,
  );
  assert.deepEqual(deleted(), []);
  assert.deepEqual(
    { ...presenceRow() },
    {
      sequence: 3,
      issuedAt: T0 + 5,
      expiresAt: T0 + 60_000,
      digest: 'd'.repeat(64),
      json: '{"kind":"presence","sequence":3}',
    },
  );
  // The high-water guard still blocks a stale presence.
  assert.equal(
    await storage.put(
      entry(PUBLIC_RECORD_KINDS.PRESENCE, node, 3, {
        json: '{"stale":1}',
        signature: 'other',
      }),
    ),
    false,
  );
  assert.equal(presenceRow()?.json, '{"kind":"presence","sequence":3}');
  await storage.put(
    entry(PUBLIC_RECORD_KINDS.CATALOG, node, 4, { models: ['m'] }),
  );
  // A catalog legitimately clears the presence, but replaces the catalog in place.
  assert.deepEqual(deleted(), ['presence']);
  await storage.put(entry(PUBLIC_RECORD_KINDS.WITHDRAWAL, node, 5));
  await storage.put(
    entry(PUBLIC_RECORD_KINDS.CATALOG, node, 6, {
      models: ['m'],
      digest: 'e'.repeat(64),
    }),
  );
  await storage.put(
    entry(PUBLIC_RECORD_KINDS.WITHDRAWAL, node, 7, { digest: 'e'.repeat(64) }),
  );
  assert.deepEqual(deleted(), ['presence']);
  const withdrawal = db.raw
    .prepare('SELECT sequence FROM discovery_withdrawals WHERE node_id = ?')
    .get(node);
  assert.equal(withdrawal?.sequence, 7);
});

void test('D1 listing takes its NodeId order from the model index, then reads blobs by key for the page', async (context) => {
  const made = await recordingD1();
  if (!made) return context.skip('node:sqlite unavailable');
  const { db, read, storage } = made;
  for (const after of [null, { nodeId: 'a'.repeat(64) }]) {
    await storage.list({ model: 'm', now: T0, limit: 51, after });
    const statement = read.at(-1);
    assert.ok(statement);
    const plan = explainD1Statement(db, statement);
    const byId = new Map(plan.map((row) => [row.id, row]));
    const inPage = (row: SqliteQueryPlanRow): boolean => {
      const parent = byId.get(row.parent);
      if (!parent) return false;
      return /^(CO-ROUTINE|MATERIALIZE) /.test(parent.detail) || inPage(parent);
    };
    const detail = plan.map((row) => row.detail).join('\n');
    // No sort: the page walks discovery_catalog_models_by_model in NodeId order from the cursor.
    assert.ok(!detail.includes('TEMP B-TREE'), detail);
    assert.match(
      detail,
      after
        ? /SEARCH discovery_catalog_models USING COVERING INDEX discovery_catalog_models_by_model \(model_id=\? AND node_id>\?\)/
        : /SEARCH discovery_catalog_models USING COVERING INDEX discovery_catalog_models_by_model \(model_id=\?\)/,
    );
    // Inside the page every table read is a covering index: no blob row is touched.
    const pageReads = plan.filter(
      (row) => inPage(row) && /^(SEARCH|SCAN) /.test(row.detail),
    );
    assert.ok(pageReads.length >= 3, detail);
    for (const row of pageReads)
      assert.match(row.detail, /USING COVERING INDEX/, detail);
    // Blobs are read afterwards by primary key, once per page row.
    const blobReads = plan.filter(
      (row) => !inPage(row) && / USING PRIMARY KEY /.test(row.detail),
    );
    assert.equal(blobReads.length, 2, detail);
  }
});

async function seedListing(storage: DiscoveryStorage) {
  for (let i = 1; i <= 40; i++) {
    const nodeId = hex(i);
    const digest = hex(1000 + i);
    // Presence times out of NodeId order: the listing ignores them.
    const issuedAt = T0 - (i % 7);
    await storage.put(
      entry(PUBLIC_RECORD_KINDS.CATALOG, nodeId, 1, {
        digest,
        issuedAt: T0 - 10,
        expiresAt: T0 + 600_000,
        models: i % 5 === 0 ? ['other'] : ['m', 'other'],
        json: `{"catalog":${i},"pad":"${'x'.repeat(i * 3)}"}`,
      }),
    );
    if (i % 9 === 0 || i % 11 === 0) continue;
    await storage.put(
      entry(PUBLIC_RECORD_KINDS.PRESENCE, nodeId, 2, {
        digest,
        issuedAt,
        expiresAt: i % 13 === 0 ? T0 : T0 + 60_000,
        json: `{"presence":${i}}`,
      }),
    );
    if (i % 8 === 0)
      await storage.put(
        entry(PUBLIC_RECORD_KINDS.WITHDRAWAL, nodeId, 3, {
          digest,
          issuedAt: T0 - 1,
          expiresAt: T0 + 600_000,
        }),
      );
  }
}

void test('D1 and memory listings are identical across pages, in NodeId order', async (context) => {
  const made = await recordingD1();
  if (!made) return context.skip('node:sqlite unavailable');
  const memory = createMemoryStorage();
  await seedListing(made.storage);
  await seedListing(memory);
  for (const limit of [1, 4, 7, 50]) {
    let after: SellerCursor | null = null;
    const pages: string[] = [];
    for (let page = 0; page < 40; page++) {
      const query: SellerQuery = { model: 'm', now: T0, limit, after };
      const fromD1: SellerRow[] = await made.storage.list(query);
      assert.deepEqual(fromD1, await memory.list(query));
      pages.push(...fromD1.map((row) => row.nodeId));
      const last = fromD1.at(-1);
      if (!last || fromD1.length < limit) break;
      after = { nodeId: last.nodeId };
    }
    assert.ok(pages.length > 10);
    assert.deepEqual(pages, [...pages].sort());
    assert.equal(new Set(pages).size, pages.length);
  }
});

// Changing admission lists must not create extra capacity over retained older identities.
void test('changing the allowlist cannot bypass capacity held by an earlier publisher', async () => {
  const storage = createMemoryStorage();
  const first = indexNode();
  const second = indexNode();
  const publish = async (seller: ReturnType<typeof indexNode>) => {
    const publishers: DiscoveryPublishers = {
      mode: PUBLISH_MODES.ALLOWLIST,
      nodeIds: new Set([seller.nodeId]),
    };
    const app = createDiscoveryIndex({
      storage,
      publishers,
      limiters: allLimiters(),
      now: () => T0 + 1000,
      maxNodes: 1,
    });
    return app.fetch(
      new Request(INDEX_ORIGIN + '/v1/records', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': CLIENT_IP,
        },
        body: JSON.stringify({ record: seller.catalog(1) }),
      }),
    );
  };
  assert.equal((await publish(first)).status, 201);
  assert.equal((await publish(second)).status, 429);
  assert.ok(await storage.state(first.nodeId));
  assert.equal(await storage.state(second.nodeId), null);
});

void test('D1 network sightings read one uptime row per NodeId through the primary key', async (context) => {
  const made = await recordingD1();
  if (!made) return context.skip('node:sqlite unavailable');
  const { db, read, storage } = made;
  await storage.sightings(0, 10);
  const statement = read.at(-1);
  assert.ok(statement);
  const detail = explainD1Statement(db, statement)
    .map((row) => row.detail)
    .join('\n');
  // The newest hourly row by (node_id, hour), never an aggregate scan of a NodeId's history.
  assert.match(
    detail,
    /SEARCH discovery_uptime USING PRIMARY KEY \(node_id=\? AND hour>\?\)/,
  );
  assert.doesNotMatch(detail, /SCAN discovery_uptime\b(?!_nodes)/);
  assert.doesNotMatch(detail, /TEMP B-TREE/);
});
