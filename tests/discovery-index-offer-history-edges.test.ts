import assert from 'node:assert/strict';
import test from 'node:test';

import { OFFER_HISTORY } from '@gyblos/discovery-index/constants';
import type {
  DiscoveryStorage,
  StoredEntry,
} from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import type { PublicCatalogV2 } from '@gyblos/protocol/control-types';

import { createSqliteD1 } from './support/d1-sqlite';
import {
  eachStorage,
  INDEX_OWNER,
  indexNode,
  MODEL,
  T0,
} from './support/discovery-index-fixture';
import {
  accepted,
  DAY,
  history,
  HISTORY,
  priced,
} from './support/offer-history';

const OTHER_OWNER = '11111111111111111111111111111111';
const NODE = 'ab'.repeat(32);
const RETENTION = OFFER_HISTORY.retentionDays * DAY;

function entry(sequence: number, now: number, price: string): StoredEntry {
  const offers = [
    {
      modelId: MODEL,
      variant: null,
      quantization: null,
      contextTokens: 2048,
      pricing: {
        network: 'n',
        asset: 'a',
        unit: 'million-tokens',
        inputAtomicPerMtok: '0',
        outputAtomicPerMtok: price,
      },
      reasoning: [],
    },
  ];
  return {
    admission: { now, maxNodes: 100, maxPublications: 100 },
    kind: PUBLIC_RECORD_KINDS.CATALOG,
    nodeId: NODE,
    owner: OTHER_OWNER,
    sequence,
    issuedAt: now,
    expiresAt: now + 600_000,
    digest: `digest-${sequence}`,
    models: [MODEL],
    signature: `signature-${sequence}`,
    retainUntil: now + RETENTION * 2,
    json: '{}',
    offers: { hash: `hash-${price}`, json: JSON.stringify(offers) },
  };
}

const periodsOf = (storage: DiscoveryStorage) =>
  storage.offerHistory({ nodeId: NODE, model: null, since: 0, limit: 10 });

eachStorage(
  'an owner change with the same offers splits the period',
  async (harness) => {
    const node = indexNode();
    await accepted(harness, priced(node, 1, '2'));
    harness.clock.now += 1000;
    const record = structuredClone(
      priced(node, 2, '2').record,
    ) as PublicCatalogV2;
    record.owner = OTHER_OWNER;
    await accepted(harness, node.sign(record));
    const { periods } = await history(harness, `node=${node.nodeId}`);
    assert.deepEqual(
      periods.map((period) => [period.owner, period.endReason]),
      [
        [OTHER_OWNER, null],
        [INDEX_OWNER, 'replaced'],
      ],
    );
  },
);

eachStorage(
  'more periods than one answer holds are truncated',
  async (harness) => {
    const node = indexNode();
    for (
      let sequence = 1;
      sequence <= OFFER_HISTORY.maxPeriods + 1;
      sequence++
    ) {
      harness.clock.now += 7000;
      await accepted(
        harness,
        priced(node, sequence, String(sequence), {
          issuedAt: harness.clock.now,
        }),
      );
    }
    const { periods, truncated } = await history(
      harness,
      `node=${node.nodeId}`,
    );
    assert.equal(truncated, true);
    assert.equal(periods.length, OFFER_HISTORY.maxPeriods);
    assert.equal(periods[0]!.firstSequence, OFFER_HISTORY.maxPeriods + 1);
  },
);

eachStorage(
  'an answer stops before the response size cap',
  async (harness) => {
    const node = indexNode();
    for (let sequence = 1; sequence <= 6; sequence++) {
      harness.clock.now += 7000;
      await accepted(
        harness,
        priced(node, sequence, String(sequence), {
          issuedAt: harness.clock.now,
        }),
      );
    }
    const response = await harness.call(`${HISTORY}?node=${node.nodeId}`);
    const text = await response.text();
    const body = JSON.parse(text) as { periods: unknown[]; truncated: boolean };
    assert.ok(text.length <= 2000, String(text.length));
    assert.equal(body.truncated, true);
    assert.ok(body.periods.length > 0 && body.periods.length < 6);
  },
  { maxResponseBytes: 2000 },
);

eachStorage(
  'history reads are public, cached and normalized',
  async (harness) => {
    const node = indexNode();
    await accepted(harness, priced(node, 1, '2'));
    const response = await harness.call(
      `${HISTORY}?days=30&node=${node.nodeId}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=10');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    const refused = await harness.call(`${HISTORY}?days=0&node=${node.nodeId}`);
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get('Access-Control-Allow-Origin'), '*');
  },
);

eachStorage(
  'period times never move backwards when isolates race',
  async ({ storage }) => {
    assert.equal(await storage.put(entry(1, T0 + 100_000, '1')), true);
    assert.equal(await storage.put(entry(2, T0 + 50_000, '1')), true);
    let [open] = await periodsOf(storage);
    assert.equal(open!.lastPublishedAt, T0 + 100_000);
    assert.equal(await storage.put(entry(3, T0 + 60_000, '2')), true);
    const [current, previous] = await periodsOf(storage);
    assert.equal(previous!.endedAt, T0 + 100_000);
    assert.ok(current!.startedAt >= previous!.endedAt!);
    open = current;
    assert.equal(open!.endedAt, null);
  },
);

eachStorage(
  'pruning drops history older than the retention period',
  async ({ storage }) => {
    await storage.put(entry(1, T0, '1'));
    await storage.put(entry(2, T0 + 60_000, '2'));
    const later = T0 + RETENTION + DAY;
    await storage.put(entry(3, later, '3'));
    await storage.prune(later);
    assert.deepEqual(
      (await periodsOf(storage)).map((period) => period.firstSequence),
      [3],
    );
  },
);

void test('pruning drops offer rows no kept period references', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const storage = createD1Storage(db);
  await storage.put(entry(1, T0, '1'));
  await storage.put(entry(2, T0 + 60_000, '2'));
  const later = T0 + RETENTION + DAY;
  await storage.put(entry(3, later, '2'));
  await storage.prune(later);
  const hashes = db.raw
    .prepare(
      'SELECT DISTINCT content_hash AS hash FROM discovery_offer_items ORDER BY hash',
    )
    .all()
    .map((row) => row.hash);
  assert.deepEqual(hashes, ['hash-2']);
});
