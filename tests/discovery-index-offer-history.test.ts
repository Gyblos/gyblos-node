import assert from 'node:assert/strict';
import test from 'node:test';

import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';

import { createSqliteD1, type SqliteD1 } from './support/d1-sqlite';
import {
  eachStorage,
  expectError,
  indexHarness,
  indexNode,
  MODEL,
  T0,
} from './support/discovery-index-fixture';
import {
  accepted,
  DAY,
  history,
  HISTORY,
  MINUTE,
  priced,
} from './support/offer-history';

eachStorage(
  'a catalog opens a period with its exact prices',
  async (harness) => {
    const node = indexNode();
    await accepted(harness, priced(node, 1, '12345678901234567'));
    const { periods, truncated } = await history(
      harness,
      `node=${node.nodeId}`,
    );
    assert.equal(truncated, false);
    assert.equal(periods.length, 1);
    const [period] = periods;
    assert.equal(period!.nodeId, node.nodeId);
    assert.equal(period!.firstSequence, 1);
    assert.equal(period!.startedAt, harness.clock.now);
    assert.equal(period!.lastPublishedAt, harness.clock.now);
    assert.equal(period!.expiresAt, T0 + 600_000);
    assert.equal(period!.endedAt, null);
    assert.equal(period!.endReason, null);
    assert.deepEqual(period!.offers, [
      {
        modelId: MODEL,
        variant: null,
        quantization: 'Q4_K_M',
        contextTokens: 2048,
        reasoning: ['off'],
        pricing: {
          inputAtomicPerMtok: '0',
          outputAtomicPerMtok: '12345678901234567',
          unit: 'million-tokens',
          network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
          asset: '11111111111111111111111111111111',
        },
      },
    ]);
  },
);

eachStorage(
  'renewing the same offers extends the open period',
  async (harness) => {
    const node = indexNode();
    const started = harness.clock.now;
    await accepted(harness, priced(node, 1, '2'));
    harness.clock.now += 5 * MINUTE;
    await accepted(
      harness,
      priced(node, 2, '2', { issuedAt: T0 + 5 * MINUTE }),
    );
    const { periods } = await history(harness, `node=${node.nodeId}`);
    assert.equal(periods.length, 1);
    assert.equal(periods[0]!.startedAt, started);
    assert.equal(periods[0]!.lastPublishedAt, harness.clock.now);
    assert.equal(periods[0]!.expiresAt, T0 + 5 * MINUTE + 600_000);
    assert.equal(periods[0]!.endedAt, null);
  },
);

eachStorage(
  'a price change closes the period and opens a new one',
  async (harness) => {
    const node = indexNode();
    await accepted(harness, priced(node, 1, '2'));
    harness.clock.now += MINUTE;
    const changed = harness.clock.now;
    await accepted(harness, priced(node, 2, '3', { issuedAt: T0 + MINUTE }));
    const { periods } = await history(harness, `node=${node.nodeId}`);
    assert.equal(periods.length, 2);
    const [current, previous] = periods;
    assert.equal(current!.firstSequence, 2);
    assert.equal(current!.startedAt, changed);
    assert.equal(current!.endedAt, null);
    assert.equal(current!.offers[0]!.pricing.outputAtomicPerMtok, '3');
    assert.equal(previous!.firstSequence, 1);
    assert.equal(previous!.endedAt, changed);
    assert.equal(previous!.endReason, 'replaced');
    assert.equal(previous!.offers[0]!.pricing.outputAtomicPerMtok, '2');
  },
);

eachStorage('dropping a model opens a period without it', async (harness) => {
  const node = indexNode();
  await accepted(
    harness,
    priced(node, 1, '2', { models: [MODEL, 'other-1b'] }),
  );
  harness.clock.now += MINUTE;
  await accepted(harness, priced(node, 2, '2', { issuedAt: T0 + MINUTE }));
  const { periods } = await history(harness, `node=${node.nodeId}`);
  assert.deepEqual(
    periods.map((period) => period.offers.map((offer) => offer.modelId)),
    [[MODEL], [MODEL, 'other-1b']],
  );
});

eachStorage('a withdrawal closes the open period', async (harness) => {
  const node = indexNode();
  const catalog = priced(node, 1, '2');
  await accepted(harness, catalog);
  harness.clock.now += MINUTE;
  await accepted(harness, await node.withdrawal(2, catalog));
  const { periods } = await history(harness, `node=${node.nodeId}`);
  assert.equal(periods.length, 1);
  assert.equal(periods[0]!.endedAt, harness.clock.now);
  assert.equal(periods[0]!.endReason, 'withdrawn');
});

eachStorage(
  'the same offers after the catalog expired start a new period',
  async (harness) => {
    const node = indexNode();
    await accepted(harness, priced(node, 1, '2'));
    harness.clock.now = T0 + DAY;
    await accepted(harness, priced(node, 2, '2', { issuedAt: T0 + DAY }));
    const { periods } = await history(harness, `node=${node.nodeId}`);
    assert.equal(periods.length, 2);
    assert.equal(periods[1]!.endedAt, T0 + 600_000);
    assert.equal(periods[1]!.endReason, 'expired');
    assert.equal(periods[0]!.endedAt, null);
  },
);

eachStorage('a replayed or rejected record writes nothing', async (harness) => {
  const node = indexNode();
  const catalog = priced(node, 1, '2');
  await accepted(harness, catalog);
  const before = (await history(harness, `node=${node.nodeId}`)).periods;
  harness.clock.now += MINUTE;
  assert.equal((await harness.publish(catalog)).status, 409);
  assert.equal((await harness.publish(priced(node, 1, '9'))).status, 409);
  assert.deepEqual(
    (await history(harness, `node=${node.nodeId}`)).periods,
    before,
  );
});

eachStorage('presence does not touch the history', async (harness) => {
  const node = indexNode();
  const catalog = priced(node, 1, '2');
  await accepted(harness, catalog);
  const before = await history(harness, `node=${node.nodeId}`);
  await accepted(harness, await node.presence(2, catalog));
  assert.deepEqual(await history(harness, `node=${node.nodeId}`), before);
});

eachStorage(
  'a model query returns every seller period listing it',
  async (harness) => {
    const first = indexNode();
    const second = indexNode();
    await accepted(
      harness,
      priced(first, 1, '2', { models: [MODEL, 'other-1b'] }),
    );
    harness.clock.now += MINUTE;
    await accepted(harness, priced(second, 1, '5'));
    const { periods } = await history(harness, `model=${MODEL}`);
    assert.deepEqual(
      periods.map((period) => [
        period.nodeId,
        period.offers.map((offer) => offer.modelId),
      ]),
      [
        [second.nodeId, [MODEL]],
        [first.nodeId, [MODEL]],
      ],
    );
    assert.deepEqual((await history(harness, 'model=absent')).periods, []);
  },
);

eachStorage('periods older than the window are left out', async (harness) => {
  const node = indexNode();
  await accepted(harness, priced(node, 1, '2'));
  harness.clock.now = T0 + 10 * DAY;
  await accepted(harness, priced(node, 2, '3', { issuedAt: T0 + 10 * DAY }));
  assert.equal(
    (await history(harness, `node=${node.nodeId}&days=7`)).periods.length,
    1,
  );
  assert.equal(
    (await history(harness, `node=${node.nodeId}`)).periods.length,
    2,
  );
});

eachStorage('malformed history queries are refused', async (harness) => {
  const node = indexNode().nodeId;
  for (const query of [
    '',
    `node=${node}&model=${MODEL}`,
    `node=${node}&node=${node}`,
    'node=XYZ',
    `node=${node}&days=0`,
    `node=${node}&days=93`,
    `node=${node}&days=07`,
    `node=${node}&limit=5`,
    'model=',
  ])
    await expectError(
      await harness.call(`${HISTORY}?${query}`),
      400,
      'INVALID_QUERY',
    );
});

void test('a catalog of the largest size stays within D1 parameters', async (context) => {
  const db = await createSqliteD1();
  if (!db) {
    context.skip('node:sqlite unavailable');
    return;
  }
  const checked: SqliteD1 = {
    ...db,
    batch: async (statements) => {
      for (const statement of statements)
        assert.ok(
          'params' in statement &&
            Array.isArray(statement.params) &&
            statement.params.length <= 100,
          'D1 accepts at most 100 parameters per statement',
        );
      return db.batch(statements);
    },
  };
  const harness = await indexHarness('sqlite-d1', {
    storage: createD1Storage(checked),
  });
  assert.ok(harness);
  const node = indexNode();
  const models = Array.from(
    { length: PUBLIC_RECORD_LIMITS.maxModels },
    (_, index) => `model-${index}`,
  );
  await accepted(harness, priced(node, 1, '2', { models }));
  const { periods } = await history(harness, `node=${node.nodeId}`);
  assert.equal(periods[0]!.offers.length, PUBLIC_RECORD_LIMITS.maxModels);
});
