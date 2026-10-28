// Verifies per-ALPN service quotas without sockets, engines, payments or existing state.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CODES } from '@gyblos/protocol/constants';

import { controlFixture } from './support/control-fixture';

void test('seller control quotas aggregate the same NodeId across connections and globally', async () => {
  const { createSellerControlService } = await import('@gyblos/node/control');
  const { CONTROL_CAPACITY } = await import('@gyblos/core/constants');
  const source = await controlFixture();
  const service = createSellerControlService({
    context: source.context,
    ownerSigner: source.ownerSigner,
    nodeSigner: source.nodeSigner,
  });
  const connections: ReturnType<typeof service.open>[] = [];
  const peer = source.request.params.buyerNodeId;
  for (let index = 0; index < CONTROL_CAPACITY.connectionsPerPeer; index++)
    connections.push(service.open(peer));
  assert.throws(() => service.open(peer), { code: CONTROL_CODES.LIMIT });
  const leases = [];
  for (let index = 0; index < CONTROL_CAPACITY.queriesPerPeer; index++)
    leases.push(connections[index]!.beginQuery());
  assert.throws(() => connections[0]!.beginQuery(), {
    code: CONTROL_CODES.LIMIT,
  });
  for (
    let index = connections.length;
    index < CONTROL_CAPACITY.connections;
    index++
  ) {
    const connection = service.open(index.toString(16).padStart(64, '0'));
    connections.push(connection);
    leases.push(connection.beginQuery());
  }
  assert.throws(() => service.open('f'.repeat(64)), {
    code: CONTROL_CODES.LIMIT,
  });
  assert.throws(() => connections[4]!.beginQuery(), {
    code: CONTROL_CODES.LIMIT,
  });
  for (const lease of leases) lease.cancel();
  for (const connection of connections) connection.close();
  const restored = service.open(peer);
  restored.close();
});

void test('control reads cached readiness without describing or invoking the engine', async () => {
  const { observeControlReadiness } =
    await import('@gyblos/node/control-readiness');
  const { createSellerControlService } = await import('@gyblos/node/control');
  const { CONTROL_METHODS, CONTROL_VERSION, ENGINE_DONE_REASONS } =
    await import('@gyblos/protocol/constants');
  const source = await controlFixture();
  let executions = 0;
  let finish = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const observed = observeControlReadiness(
    {
      describe: async () => {
        throw new Error('Unexpected engine describe');
      },
      capabilities: () => {
        throw new Error('Unexpected engine capabilities');
      },
      async generate() {
        executions++;
        await held;
        return {
          text: '',
          finishReason: ENGINE_DONE_REASONS.STOP,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalDurationNs: 0,
            loadDurationNs: 0,
            inputDurationNs: 0,
            outputDurationNs: 0,
          },
        };
      },
    },
    source.context.readiness().validUntil,
    source.context.now,
  );
  const service = createSellerControlService({
    context: { ...source.context, readiness: observed.readiness },
    ownerSigner: source.ownerSigner,
    nodeSigner: source.nodeSigner,
  });
  const signal = new AbortController().signal;
  for (const method of [CONTROL_METHODS.CATALOG, CONTROL_METHODS.PRESENCE]) {
    const response = await service.respond(
      {
        version: CONTROL_VERSION,
        requestId: 'a'.repeat(32),
        method,
        params: {},
      },
      source.request.params.buyerNodeId,
      signal,
    );
    assert.ok(response.result);
  }
  await service.respond(
    source.request,
    source.request.params.buyerNodeId,
    signal,
  );
  assert.equal(executions, 0);
  // Simulate an already-authorized HTTP inference, entirely inside this synthetic engine.
  const running = observed.engine.generate({
    prompt: 'synthetic',
    maxTokens: 1,
  });
  const busy = await service.respond(
    source.request,
    source.request.params.buyerNodeId,
    signal,
  );
  assert.equal(busy.error?.code, CONTROL_CODES.BUSY);
  assert.equal(executions, 1);
  finish();
  await running;
  assert.equal(observed.readiness().busy, false);
});

void test('absolute stream timeout releases admission and never publishes a late signature', async () => {
  const { createSellerControlService } = await import('@gyblos/node/control');
  const { serveControlStream } =
    await import('@gyblos/transport-iroh/control-server');
  const { encodeControlFrame } =
    await import('@gyblos/protocol/control-framing');
  const source = await controlFixture();
  let resume = () => {};
  let finish = () => {};
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = createSellerControlService({
    context: source.context,
    nodeSigner: source.nodeSigner,
    ownerSigner: async (bytes) => {
      await held;
      const signature = await source.ownerSigner(bytes);
      finish();
      return signature;
    },
  });
  const session = service.open(source.request.params.buyerNodeId);
  const frame = encodeControlFrame(source.request);
  let offset = 0;
  let writes = 0;
  let active = 0;
  let closes = 0;
  await serveControlStream(
    {
      recv: {
        async readExact(size) {
          const bytes = frame.subarray(offset, offset + size);
          offset += size;
          return [...bytes];
        },
        async read() {
          return [];
        },
      },
      send: {
        async writeAll() {
          writes++;
        },
        async finish() {},
      },
    },
    { ...service, queryMs: 30 },
    session,
    source.request.params.buyerNodeId,
    () => {
      closes++;
    },
    new AbortController().signal,
    () => {
      active++;
      return () => {
        active--;
      };
    },
  );
  assert.equal(active, 0);
  assert.equal(writes, 0);
  assert.equal(closes, 1);
  resume();
  await finished;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  session.beginQuery().cancel();
  session.close();
});

void test('control refuses a response when relay policy changes during signing', async () => {
  const { createSellerControlService } = await import('@gyblos/node/control');
  const { serveControlStream } =
    await import('@gyblos/transport-iroh/control-server');
  const { encodeControlFrame } =
    await import('@gyblos/protocol/control-framing');
  const source = await controlFixture();
  let allowed = true;
  const service = createSellerControlService({
    context: source.context,
    nodeSigner: source.nodeSigner,
    ownerSigner: async (bytes) => {
      const signature = await source.ownerSigner(bytes);
      allowed = false;
      return signature;
    },
  });
  const peer = source.request.params.buyerNodeId;
  const session = service.open(peer);
  const frame = encodeControlFrame(source.request);
  let offset = 0;
  let writes = 0;
  let closes = 0;
  await serveControlStream(
    {
      recv: {
        async readExact(size) {
          const bytes = frame.subarray(offset, offset + size);
          offset += size;
          return [...bytes];
        },
        async read() {
          return [];
        },
      },
      send: {
        async writeAll() {
          writes++;
        },
        async finish() {},
      },
    },
    service,
    session,
    peer,
    () => {
      closes++;
    },
    new AbortController().signal,
    () => () => {},
    () => allowed,
  );
  assert.equal(writes, 0);
  assert.equal(closes, 1);
  session.close();
});
