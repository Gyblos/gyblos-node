// Session-v3 correlation, terminal equality and bounded framing are verified before any approval.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  BATCH_CHANNEL,
  BatchChannelError,
} from '@gyblos/protocol/batch-channel';
import {
  BATCH_STREAM,
  createBatchStreamVerifier,
} from '@gyblos/protocol/batch-stream';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import { createBatchChannelClient } from '@gyblos/transport-iroh/batch-client';
import { IROH_DEADLINES } from '@gyblos/transport-iroh/constants';

import { batchDeferred } from './support/batch-deferred';
import { batchLoopback } from './support/batch-loopback';
import {
  batchMemoryPeer,
  batchStreamBytes,
  batchStreamFixture,
} from './support/batch-stream-fixture';
import { within } from './support/test-deadline';

void test('session stream binds outer RPC separately from inner execution and matches complete terminal text', async () => {
  const f = await batchStreamFixture();
  assert.notEqual(f.request.requestId, f.bill.requestId);
  const verifier = await createBatchStreamVerifier(f.request);
  assert.equal((await verifier.accept(f.delta)).delta, 'ok!');
  assert.deepEqual((await verifier.accept(f.terminal)).terminal, f.response);
  verifier.finish();
  await assert.rejects(verifier.accept(f.terminal), {
    code: SESSION_CODES.INVALID,
  });
});
void test('crossed, duplicate and missing stream event sequences fail sticky', async () => {
  const f = await batchStreamFixture();
  for (const patch of [
    { requestId: 'ff'.repeat(16) },
    { requestDigest: 'ff'.repeat(32) },
    { sequence: 1 },
  ]) {
    const verifier = await createBatchStreamVerifier(f.request);
    await assert.rejects(verifier.accept({ ...f.delta, ...patch }), {
      code: SESSION_CODES.BINDING,
    });
    await assert.rejects(verifier.accept(f.delta), {
      code: SESSION_CODES.INVALID,
    });
  }
  const verifier = await createBatchStreamVerifier(f.request);
  await verifier.accept(f.delta);
  await assert.rejects(verifier.accept(f.delta), {
    code: SESSION_CODES.BINDING,
  });
});
void test('terminal must match exactly the observed output and a missing terminal cannot finish', async () => {
  const f = await batchStreamFixture();
  const verifier = await createBatchStreamVerifier(f.request);
  await verifier.accept({ ...f.delta, text: 'wrong' });
  await assert.rejects(verifier.accept(f.terminal), {
    code: SESSION_CODES.BINDING,
  });
  const incomplete = await createBatchStreamVerifier(f.request);
  await incomplete.accept(f.delta);
  assert.throws(() => incomplete.finish(), { code: SESSION_CODES.INVALID });
});
void test('session framing refuses oversized prefixes before allocating a body and marks failed first writes sent', async () => {
  const f = await batchStreamFixture();
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(BATCH_CHANNEL.responseBytes + 1);
  const peer = batchMemoryPeer(prefix);
  const client = createBatchChannelClient(
    peer.endpoint,
    peer.destination,
    peer.destination.id().toString(),
    { now: () => f.request.params.quote.offer.issuedAt },
  );
  await assert.rejects(client.exchange(f.request), {
    sent: true,
    code: SESSION_CODES.LIMIT,
  });
  assert.equal(peer.reads(), 2);
  await client.close();
  await client.settled();
  const broken = batchMemoryPeer(new Uint8Array(), true);
  const failed = createBatchChannelClient(
    broken.endpoint,
    broken.destination,
    broken.destination.id().toString(),
    { now: () => f.request.params.quote.offer.issuedAt },
  );
  await assert.rejects(failed.exchange(f.request), { sent: true });
  assert.equal(broken.writes(), 1);
  await failed.close();
  await failed.settled();
});
void test('client refuses trailing bytes or missing terminal and never returns a verified response', async () => {
  const f = await batchStreamFixture();
  for (const bytes of [
    batchStreamBytes(f.delta),
    Buffer.concat([batchStreamBytes(f.delta, f.terminal), Buffer.of(1)]),
  ]) {
    const peer = batchMemoryPeer(bytes);
    const client = createBatchChannelClient(
      peer.endpoint,
      peer.destination,
      peer.destination.id().toString(),
      { now: () => f.request.params.quote.offer.issuedAt },
    );
    await assert.rejects(client.exchange(f.request), { sent: true });
    await client.close();
    await client.settled();
  }
});
void test('client awaits each consumer before reading the terminal and verifies EOF', async () => {
  const f = await batchStreamFixture();
  const peer = batchMemoryPeer(batchStreamBytes(f.delta, f.terminal));
  const client = createBatchChannelClient(
    peer.endpoint,
    peer.destination,
    peer.destination.id().toString(),
    { now: () => f.request.params.quote.offer.issuedAt },
  );
  const entered = batchDeferred<void>();
  const release = batchDeferred<void>();
  const run = client.exchange(f.request, undefined, async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    assert.equal(peer.reads(), 3);
  } finally {
    release.resolve();
  }
  assert.deepEqual(await run, f.response);
  assert.equal(peer.reads(), 7);
  await client.close();
  await client.settled();
});
void test('event count and total encoded stream bytes remain bounded', async () => {
  const f = await batchStreamFixture();
  const count = await createBatchStreamVerifier(f.request);
  await assert.rejects(
    count.accept({ ...f.delta, sequence: BATCH_STREAM.maxEvents }),
    { code: SESSION_CODES.INVALID },
  );
  const bytes = await createBatchStreamVerifier(f.request);
  for (let sequence = 0; ; sequence++) {
    try {
      await bytes.accept({
        ...f.delta,
        sequence,
        text: '\u0001'.repeat(BATCH_STREAM.deltaBytes),
      });
    } catch (error) {
      assert.ok(error instanceof BatchChannelError);
      assert.equal(error.code, SESSION_CODES.LIMIT);
      break;
    }
  }
});

void test('an escaped terminal that cannot fit returns a static remote LIMIT frame', async (t) => {
  const f = await batchStreamFixture();
  const wire = await batchLoopback(
    {
      exchange: async () => ({
        value: { ...f.value, text: '\u0001'.repeat(262144) },
        bill: f.bill,
      }),
    },
    {
      buyerNodeId: f.request.params.quote.offer.buyerNodeId,
      sellerNodeId: f.request.params.quote.offer.nodeId,
    },
  );
  t.after(wire.close);
  const client = createBatchChannelClient(
    wire.endpoint,
    wire.destination,
    wire.destination.id().toString(),
    { now: () => f.request.params.quote.offer.issuedAt },
  );
  t.after(async () => {
    await client.close();
    await client.settled();
  });
  await assert.rejects(client.exchange(f.request), {
    code: SESSION_CODES.LIMIT,
    remote: true,
    sent: true,
  });
});

void test('cancellation drains client tracking without waiting for a stalled delta consumer', async () => {
  const f = await batchStreamFixture();
  const peer = batchMemoryPeer(batchStreamBytes(f.delta, f.terminal));
  const client = createBatchChannelClient(
    peer.endpoint,
    peer.destination,
    peer.destination.id().toString(),
    { now: () => f.request.params.quote.offer.issuedAt },
  );
  const entered = batchDeferred<void>();
  const release = batchDeferred<void>();
  const controller = new AbortController();
  const run = client.exchange(f.request, controller.signal, async () => {
    entered.resolve();
    await release.promise;
  });
  const rejected = assert.rejects(run);
  try {
    await entered.promise;
    controller.abort();
    await rejected;
    await within(client.settled(), 1000);
    assert.equal(peer.reads(), 3);
  } finally {
    release.resolve();
    controller.abort();
    await rejected;
    await client.close();
    await client.settled();
  }
});

void test('waiting for generated text uses the absolute request deadline, not partial-frame ingress', async (t) => {
  const f = await batchStreamFixture();
  const original = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    'setTimeout',
    (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      original(callback, ms === IROH_DEADLINES.ingressMs ? 1 : ms, ...args),
  );
  const peer = batchMemoryPeer(
    batchStreamBytes(f.delta, f.terminal),
    false,
    (index) => (index === 1 ? delay(20) : Promise.resolve()),
  );
  const client = createBatchChannelClient(
    peer.endpoint,
    peer.destination,
    peer.destination.id().toString(),
    { now: () => f.request.params.quote.offer.issuedAt },
  );
  try {
    assert.deepEqual(await client.exchange(f.request), f.response);
  } finally {
    await client.close();
    await client.settled();
  }
});

void test('once an event starts, a stalled partial prefix is cut off by the original ingress deadline', async (t) => {
  const f = await batchStreamFixture();
  const original = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    'setTimeout',
    (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      original(callback, ms === IROH_DEADLINES.ingressMs ? 1 : ms, ...args),
  );
  const peer = batchMemoryPeer(
    batchStreamBytes(f.delta, f.terminal),
    false,
    (index) => (index === 2 ? delay(20) : Promise.resolve()),
  );
  const client = createBatchChannelClient(
    peer.endpoint,
    peer.destination,
    peer.destination.id().toString(),
    { now: () => f.request.params.quote.offer.issuedAt },
  );
  try {
    await assert.rejects(client.exchange(f.request), {
      code: PAID_EXECUTION_CODES.TIMEOUT,
      sent: true,
    });
    assert.equal(peer.reads(), 2);
  } finally {
    await client.close();
    await client.settled();
  }
});
