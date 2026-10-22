import assert from 'node:assert/strict';
import test from 'node:test';

import type { Engine } from '@gyblos/core/engine';
import {
  assertReadinessCurrent,
  prepareSellerEngine,
} from '@gyblos/node/engine-readiness';
import type { MemorySnapshot } from '@gyblos/runtime/memory';

function fixture() {
  let generations = 0;
  const engine: Engine = {
    describe: async () => ({
      name: 'synthetic-model',
      digest: 'synthetic-digest',
      contextTokens: 2048,
    }),
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: 'digest',
    }),
    generate: async ({ signal }) => {
      generations++;
      assert.ok(signal);
      return {
        text: 'PRIVATE_GENERATED_TEXT',
        finishReason: 'length',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalDurationNs: 1,
          loadDurationNs: 1,
          inputDurationNs: 0,
          outputDurationNs: 0,
        },
      };
    },
  };
  const snapshot: MemorySnapshot = {
    source: 'linux-memavailable',
    vmAvailableBytes: 8 * 1024 ** 3,
    cgroup: {
      currentBytes: 64 * 1024 ** 2,
      limitBytes: 3 * 1024 ** 3,
      peakBytes: 64 * 1024 ** 2,
      events: { max: 0, oom: 0, oomKill: 0 },
    },
  };
  return { engine, snapshot, generations: () => generations };
}

test('insufficient VM or local cgroup headroom blocks warmup and advertisement', async () => {
  for (const side of ['vm', 'cgroup']) {
    const value = fixture(),
      records: unknown[] = [];
    let advertised = 0;
    if (side === 'vm') value.snapshot.vmAvailableBytes = 1;
    else
      value.snapshot.cgroup!.currentBytes =
        value.snapshot.cgroup!.limitBytes! - 1;
    await assert.rejects(
      prepareSellerEngine(value.engine, {
        snapshot: async () => value.snapshot,
        record: async (record) => {
          records.push(record);
        },
      }).then(() => advertised++),
      /headroom/,
    );
    assert.equal(value.generations(), 0);
    assert.equal(advertised, 0);
    assert.equal(records.length, 1);
  }
});

test('readiness waits for one successful private warmup and records no generated text', async () => {
  const value = fixture(),
    records: unknown[] = [];
  let release!: () => void,
    advertised = false;
  const previous = value.engine.generate;
  value.engine.generate = async (input) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous(input);
  };
  const ready = prepareSellerEngine(value.engine, {
    snapshot: async () => value.snapshot,
    record: async (record) => {
      records.push(record);
    },
  }).then(() => {
    advertised = true;
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(advertised, false);
  release();
  await ready;
  assert.equal(value.generations(), 1);
  assert.equal(advertised, true);
  assert.equal(records.length, 1);
  assert.ok(!JSON.stringify(records).includes('PRIVATE_GENERATED_TEXT'));
});

test('failed warmup never advertises and never retries; diagnostics omit error payloads', async () => {
  const value = fixture(),
    records: unknown[] = [];
  let attempts = 0,
    advertised = 0;
  value.engine.generate = async () => {
    attempts++;
    throw new Error('PRIVATE_RESPONSE_AND_PROMPT');
  };
  await assert.rejects(
    prepareSellerEngine(value.engine, {
      snapshot: async () => value.snapshot,
      record: async (record) => {
        records.push(record);
      },
    }).then(() => advertised++),
    /warmup/,
  );
  assert.equal(attempts, 1);
  assert.equal(advertised, 0);
  assert.equal(records.length, 1);
  assert.ok(!JSON.stringify(records).includes('PRIVATE_'));
});

test('a hung engine is aborted before readiness even if it ignores cancellation', async () => {
  const value = fixture(),
    records: unknown[] = [];
  let aborted = false,
    advertised = 0;
  value.engine.generate = async ({ signal }) => {
    signal!.addEventListener('abort', () => {
      aborted = true;
    });
    return new Promise(() => {});
  };
  await assert.rejects(
    prepareSellerEngine(value.engine, {
      snapshot: async () => value.snapshot,
      record: async (record) => {
        records.push(record);
      },
      timeoutMs: 10,
    }).then(() => advertised++),
    /warmup/,
  );
  assert.equal(aborted, true);
  assert.equal(advertised, 0);
  assert.equal(records.length, 1);
});

test('a newly observed OOM blocks readiness, while a historical unchanged counter does not', async () => {
  for (const increases of [false, true]) {
    const value = fixture(),
      records: unknown[] = [];
    let reads = 0;
    value.snapshot.cgroup!.events.oomKill = 1;
    const snapshot = async () => {
      reads++;
      return {
        ...value.snapshot,
        cgroup: {
          ...value.snapshot.cgroup!,
          events: {
            ...value.snapshot.cgroup!.events,
            oomKill: increases && reads > 1 ? 2 : 1,
          },
        },
      };
    };
    const ready = prepareSellerEngine(value.engine, {
      snapshot,
      record: async (record) => {
        records.push(record);
      },
    });
    if (increases) await assert.rejects(ready, /warmup/);
    else await ready;
    assert.equal(records.length, 1);
  }
});

test('offer expiration is anchored to private warmup, and slow startup cannot extend residency', async () => {
  const value = fixture();
  const readiness = await prepareSellerEngine(value.engine, {
    snapshot: async () => value.snapshot,
    record: async () => {},
  });
  assertReadinessCurrent(
    readiness.offerExpiresAt,
    readiness.offerExpiresAt - 1,
  );
  assert.throws(
    () =>
      assertReadinessCurrent(
        readiness.offerExpiresAt,
        readiness.offerExpiresAt,
      ),
    /expired/,
  );
  assert.throws(
    () =>
      assertReadinessCurrent(
        readiness.offerExpiresAt,
        readiness.offerExpiresAt + 60_000,
      ),
    /expired/,
  );
});
