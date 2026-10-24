// Checks seller readiness gating: memory headroom, one private warmup, no retry after failure, hung-engine
// abort, new OOM detection and offer expiry anchored to warmup.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertReadinessCurrent,
  prepareSellerEngine,
} from '@gyblos/node/engine-readiness';
import { type Engine } from '@gyblos/protocol/engine';
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

void test('insufficient VM or local cgroup headroom blocks warmup and advertisement', async () => {
  for (const side of ['vm', 'cgroup']) {
    const value = fixture();
    const records: unknown[] = [];
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

void test('readiness waits for one successful private warmup and records no generated text', async () => {
  const value = fixture();
  const records: unknown[] = [];
  let release!: () => void;
  let advertised = false;
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

void test('failed warmup never advertises and never retries; diagnostics omit error payloads', async () => {
  const value = fixture();
  const records: unknown[] = [];
  let attempts = 0;
  let advertised = 0;
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

void test('a hung engine is aborted before readiness even if it ignores cancellation', async () => {
  const value = fixture();
  const records: unknown[] = [];
  let aborted = false;
  let advertised = 0;
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

void test('a newly observed OOM blocks readiness, while a historical unchanged counter does not', async () => {
  for (const increases of [false, true]) {
    const value = fixture();
    const records: unknown[] = [];
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

void test('offer expiration is anchored to private warmup, and slow startup cannot extend residency', async () => {
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

void test('renewable probe holds actual engine settlement and honors cancellation before later work', async () => {
  const { probeSellerEngine } = await import('@gyblos/node/engine-readiness');
  const value = fixture();
  const controller = new AbortController();
  let finish!: () => void;
  let finished = false;
  let snapshots = 0;
  value.engine.generate = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      text: '',
      finishReason: 'stop',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalDurationNs: 0,
        loadDurationNs: 0,
        inputDurationNs: 0,
        outputDurationNs: 0,
      },
    };
  };
  const operation = probeSellerEngine(value.engine, controller.signal, {
    snapshot: async () => {
      snapshots++;
      return value.snapshot;
    },
  }).finally(() => {
    finished = true;
  });
  const rejected = assert.rejects(operation);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  finish();
  await rejected;
  assert.equal(snapshots, 1);
});

void test('renewable probe bounds residency from the injected clock and does not write diagnostics', async () => {
  const { probeSellerEngine } = await import('@gyblos/node/engine-readiness');
  const value = fixture();
  const result = await probeSellerEngine(
    value.engine,
    new AbortController().signal,
    {
      snapshot: async () => value.snapshot,
      now: () => 10000,
    },
  );
  assert.equal(result.offerExpiresAt, 250000);
  assert.equal(result.model.name, 'synthetic-model');
  assert.equal(value.generations(), 1);
});
