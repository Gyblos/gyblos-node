// Exercises canonical control requests, policy refusals and EOF/deadline bounds on real loopback sockets.
// Only synthetic catalogs and unfunded signers; no engine, payments or existing state.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { createSellerControlService } from '@gyblos/node/control';
import {
  CONTROL_CODES,
  CONTROL_METHODS,
  CONTROL_VERSION,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import { matchControlResponse } from '@gyblos/protocol/control-response';
import type { ControlQuery } from '@gyblos/protocol/control-types';

import { controlFixture } from './support/control-fixture';
import { controlLoopback, socketStream } from './support/control-loopback';

async function fixture(queryMs?: number) {
  const source = await controlFixture();
  const service = createSellerControlService({
    context: source.context,
    ownerSigner: source.ownerSigner,
    nodeSigner: source.nodeSigner,
  });
  const wire = await controlLoopback(
    { ...service, ...(queryMs ? { queryMs } : {}) },
    source.request.params.buyerNodeId,
  );
  const client = createBuyerControlClient(
    { ...wire.transport, remoteNodeId: source.catalog.nodeId },
    {
      owner: source.catalog.owner,
      nodeId: source.catalog.nodeId,
      now: source.context.now,
      relayAllowed: () => true,
    },
  );
  return { ...source, service, wire, client };
}
void test('loopback fetches authenticated catalog/presence and buyer-bound signed quote without HTTP or engine calls', async () => {
  const run = await fixture();
  try {
    const catalog = await run.client.getCatalog();
    assert.equal(catalog.record.kind, 'catalog');
    const presence = await run.client.getPresence();
    assert.equal(presence.record.kind, 'presence');
    const quote = await run.client.requestOffer(run.request.params);
    assert.equal(quote.offer.buyerNodeId, run.request.params.buyerNodeId);
    assert.equal(quote.offer.model.name, 'internal/model');
    assert.equal(run.wire.queries, 3);
  } finally {
    await run.wire.close();
  }
});
void test('loopback unsupported reasoning wins over busy and supported reasoning is refused busy', async () => {
  const run = await fixture();
  run.setReadiness({ busy: true });
  try {
    await assert.rejects(
      run.client.requestOffer({
        ...run.request.params,
        reasoning: REASONING_LEVELS.HIGH,
      }),
      { code: CONTROL_CODES.LEVEL },
    );
    await assert.rejects(run.client.requestOffer(run.request.params), {
      code: CONTROL_CODES.BUSY,
    });
  } finally {
    await run.wire.close();
  }
});
void test('buyer rejects mismatched catalog requestId before accepting seller data', async () => {
  const source = await controlFixture();
  const client = createBuyerControlClient(
    {
      localNodeId: source.request.params.buyerNodeId,
      remoteNodeId: source.catalog.nodeId,
      exchange: async () => ({
        version: CONTROL_VERSION,
        requestId: 'f'.repeat(32),
        result: {
          method: CONTROL_METHODS.CATALOG,
          catalog: source.context.catalog,
        },
      }),
      async close() {},
    },
    { ...source.trust(), now: source.context.now },
  );
  await assert.rejects(client.getCatalog(), { code: CONTROL_CODES.POLICY });
});
void test('presence response and typed error must match the request id and method too', () => {
  const query: ControlQuery = {
    version: CONTROL_VERSION,
    requestId: '1'.repeat(32),
    method: CONTROL_METHODS.PRESENCE,
    params: {},
  };
  assert.throws(
    () =>
      matchControlResponse(
        {
          version: CONTROL_VERSION,
          requestId: '2'.repeat(32),
          error: { code: CONTROL_CODES.BUSY },
        },
        query,
      ),
    { code: CONTROL_CODES.POLICY },
  );
});
void test('loopback rejects oversized prefix without waiting for its body', async () => {
  const run = await fixture();
  try {
    const socket = await run.wire.socket();
    const closed = once(socket, 'end', { signal: AbortSignal.timeout(1000) });
    socket.resume();
    socket.write(Buffer.from([0, 1, 0, 0]));
    await closed;
    socket.destroy();
    assert.equal(socket.destroyed, true);
  } finally {
    await run.wire.close();
  }
});
void test('loopback incomplete slow prefix is cut off at the absolute deadline', async () => {
  const run = await fixture(30);
  try {
    const socket = await run.wire.socket();
    const closed = once(socket, 'end', { signal: AbortSignal.timeout(1000) });
    socket.resume();
    socket.write(Buffer.from([0]));
    await closed;
    socket.destroy();
    assert.equal(socket.destroyed, true);
  } finally {
    await run.wire.close();
  }
});
void test('loopback fragmented prefix works but trailing bytes close the stream', async () => {
  const run = await fixture();
  try {
    const request: ControlQuery = {
      version: CONTROL_VERSION,
      requestId: '1'.repeat(32),
      method: CONTROL_METHODS.CATALOG,
      params: {},
    };
    const bytes = encodeControlFrame(request);
    const socket = await run.wire.socket();
    for (const byte of bytes.subarray(0, 4)) socket.write(Buffer.from([byte]));
    socket.end(bytes.subarray(4));
    const response = await import('@gyblos/transport-iroh/control-io').then(
      ({ readControlFrame }) => readControlFrame(socketStream(socket), 65536),
    );
    assert.equal(
      matchControlResponse(response, request).method,
      CONTROL_METHODS.CATALOG,
    );
    socket.destroy();
    const extra = await run.wire.socket();
    const closed = once(extra, 'end', { signal: AbortSignal.timeout(1000) });
    extra.resume();
    extra.end(Buffer.concat([bytes, Buffer.from([0])]));
    await closed;
    extra.destroy();
  } finally {
    await run.wire.close();
  }
});
void test('zero skew refuses a future catalog instead of silently accepting it', async () => {
  const run = await fixture();
  try {
    const client = createBuyerControlClient(
      { ...run.wire.transport, remoteNodeId: run.catalog.nodeId },
      {
        ...run.trust(),
        now: () => run.context.now() - 1,
      },
    );
    await assert.rejects(client.getCatalog(), { code: CONTROL_CODES.EXPIRED });
  } finally {
    await run.wire.close();
  }
});

void test('buyer refuses a replayed presence even with a fresh matching response id', async () => {
  const run = await fixture();
  let cached: unknown;
  const client = createBuyerControlClient(
    {
      ...run.wire.transport,
      remoteNodeId: run.catalog.nodeId,
      async exchange(value, signal) {
        const query = value as ControlQuery;
        if (query.method !== CONTROL_METHODS.PRESENCE)
          return run.wire.transport.exchange(value, signal);
        if (!cached) cached = await run.wire.transport.exchange(value, signal);
        return { ...(cached as object), requestId: query.requestId };
      },
    },
    { ...run.trust(), now: run.context.now },
  );
  try {
    await client.getPresence();
    await assert.rejects(client.getPresence(), { code: CONTROL_CODES.STALE });
  } finally {
    await run.wire.close();
  }
});
