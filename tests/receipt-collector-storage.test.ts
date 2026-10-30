// Checks atomic conflict and cancellation obligations with synthetic memory stores; no real persistence.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECEIPT_COLLECTOR_CODES as CODES,
  RECEIPT_COLLECTOR_LIMITS,
  RECEIPT_COLLECTOR_WRITES,
  RECEIPT_COLLECTOR_STATUSES as STATUSES,
} from '@gyblos/core/constants';
import {
  createPrivateReceiptCollector,
  type PrivateReceiptStore,
} from '@gyblos/core/receipt-collector';
import {
  RECEIPT_DISPUTE_FIELDS,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import { signBuyerReceipt } from '@gyblos/protocol/receipt';

import {
  collectorPair,
  collectorStore,
  receiptBytes,
} from './support/receipt-collector';

void test('collector preserves the first buyer attestation when timing is re-signed', async () => {
  const { pair, buyer } = await collectorPair();
  const changed = {
    ...pair,
    buyer: await signBuyerReceipt(
      {
        ...pair.buyer.record,
        observed: { ...pair.buyer.record.observed, totalMs: 45 },
      },
      buyer.sign,
    ),
  };
  const memory = collectorStore();
  const collector = createPrivateReceiptCollector(memory.store);
  const results = await Promise.allSettled([
    collector.collect(receiptBytes(pair)),
    collector.collect(receiptBytes(changed)),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const refused = results.find((result) => result.status === 'rejected');
  assert.equal(refused?.reason.code, CODES.CONFLICT);
  assert.equal(memory.entries.size, 1);
});
void test('independent collector instances share atomic duplicate decisions in one backend', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore();
  const first = createPrivateReceiptCollector(memory.store);
  const second = createPrivateReceiptCollector(memory.store);
  const results = await Promise.all([
    first.collect(receiptBytes(pair)),
    second.collect(receiptBytes(pair)),
  ]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [STATUSES.STORED, STATUSES.DUPLICATE].sort(),
  );
  assert.equal(memory.entries.size, 1);
});
void test('collector cancellation during signature verification prevents the storage call', async () => {
  const { pair } = await collectorPair();
  const memory = collectorStore();
  const controller = new AbortController();
  const result = createPrivateReceiptCollector(memory.store).collect(
    receiptBytes(pair),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(result, { code: CODES.CANCELLED });
  assert.equal(memory.calls(), 0);
});
void test('collector suppresses a late acknowledgement without promising rollback after commit', async () => {
  const { pair } = await collectorPair();
  const controller = new AbortController();
  const memory = collectorStore();
  const store: PrivateReceiptStore = {
    async insert(entry, signal) {
      const outcome = await memory.store.insert(entry, signal);
      controller.abort();
      return outcome;
    },
  };
  const collector = createPrivateReceiptCollector(store);
  await assert.rejects(
    collector.collect(receiptBytes(pair), controller.signal),
    { code: CODES.CANCELLED },
  );
  assert.equal(memory.entries.size, 1);
  assert.deepEqual(await collector.collect(receiptBytes(pair)), {
    status: STATUSES.DUPLICATE,
  });
});
void test('collector rejects invented dispute fields in a signed buyer attestation', async () => {
  const { pair } = await collectorPair(undefined, (record) => ({
    ...record,
    verdict: RECEIPT_VERDICTS.DISPUTED,
    disputed: [RECEIPT_DISPUTE_FIELDS.INPUT_TOKENS],
  }));
  const memory = collectorStore();
  await assert.rejects(
    createPrivateReceiptCollector(memory.store).collect(receiptBytes(pair)),
    { code: CODES.DISPUTE },
  );
  assert.equal(memory.calls(), 0);
});
void test('collector capacity refusal preserves duplicate acknowledgements at a full backend', async () => {
  const first = await collectorPair();
  const second = await collectorPair();
  const memory = collectorStore(1);
  const collector = createPrivateReceiptCollector(memory.store);
  await collector.collect(receiptBytes(first.pair));
  await assert.rejects(collector.collect(receiptBytes(second.pair)), {
    code: CODES.LIMIT,
  });
  assert.deepEqual(await collector.collect(receiptBytes(first.pair)), {
    status: STATUSES.DUPLICATE,
  });
  assert.deepEqual([...memory.entries.values()][0]!.receipt, first.pair);
});

void test('collector keeps cancelled backend work in its bounded pool until it settles', async () => {
  const { pair } = await collectorPair();
  let release = () => {};
  const pendingStore = new Promise<void>((resolve) => {
    release = resolve;
  });
  let announce = () => {};
  const allEntered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let calls = 0;
  const store: PrivateReceiptStore = {
    async insert() {
      calls++;
      if (calls > RECEIPT_COLLECTOR_LIMITS.active)
        return RECEIPT_COLLECTOR_WRITES.IDENTICAL;
      if (calls === RECEIPT_COLLECTOR_LIMITS.active) announce();
      await pendingStore;
      return RECEIPT_COLLECTOR_WRITES.IDENTICAL;
    },
  };
  const controller = new AbortController();
  const collector = createPrivateReceiptCollector(store);
  const work = Array.from(
    { length: RECEIPT_COLLECTOR_LIMITS.active },
    (_, index) =>
      collector.collect(
        receiptBytes(pair),
        index === 0 ? controller.signal : undefined,
      ),
  );
  const settled = Promise.allSettled(work);
  await allEntered;
  controller.abort();
  try {
    await assert.rejects(collector.collect(receiptBytes(pair)), {
      code: CODES.BUSY,
    });
  } finally {
    release();
    await settled;
  }
  const results = await settled;
  const cancelled = results[0];
  assert.equal(cancelled?.status, 'rejected');
  if (cancelled?.status === 'rejected')
    assert.equal(cancelled.reason.code, CODES.CANCELLED);
  assert.ok(results.slice(1).every((result) => result.status === 'fulfilled'));
  assert.deepEqual(await collector.collect(receiptBytes(pair)), {
    status: STATUSES.DUPLICATE,
  });
});
