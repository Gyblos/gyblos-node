// Deterministic Iroh client failures prove identity, transmission uncertainty and late cleanup.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  BatchClientError,
  createBatchChannelClient,
  type BatchConnection,
  type BatchEndpoint,
} from '@gyblos/transport-iroh/batch-client';

import { batchDeferred } from './support/batch-deferred';
import { paidSource } from './support/paid-fixture';

const seller = '34'.repeat(32);
const destination = {
  id: () => ({ toString: () => seller }),
  relayUrl: () => null,
};
const request: BatchChannelRequest = {
  version: BATCH_CHANNEL.version,
  requestId: '12'.repeat(16),
  method: BATCH_METHODS.SNAPSHOT,
  params: { channelId: '11111111111111111111111111111111' },
};
function fixture() {
  const closed = batchDeferred<void>();
  let closes = 0;
  let writes = 0;
  let connects = 0;
  let streams = 0;
  const connection: BatchConnection = {
    remoteId: destination.id,
    paths: () => [],
    closed: () => closed.promise,
    close() {
      closes++;
      closed.resolve();
    },
    async openBi() {
      streams++;
      return {
        recv: {
          async readExact() {
            return [];
          },
          async read() {
            return [];
          },
        },
        send: {
          async writeAll() {
            writes++;
            throw new Error('Synthetic partial write');
          },
          async finish() {},
        },
      };
    },
  };
  const endpoint: BatchEndpoint<typeof destination> = {
    id: () => ({ toString: () => '56'.repeat(32) }),
    async connect() {
      connects++;
      return connection;
    },
  };
  return {
    endpoint,
    connection,
    closes: () => closes,
    writes: () => writes,
    connects: () => connects,
    streams: () => streams,
  };
}
void test('batch client marks a failed first write as possibly sent and never retries', async () => {
  const f = fixture();
  const client = createBatchChannelClient(f.endpoint, destination, seller);
  await assert.rejects(
    client.exchange(request),
    (error) =>
      error instanceof BatchClientError &&
      error.sent &&
      error.code === PAID_EXECUTION_CODES.INTERNAL,
  );
  await client.close();
  await client.settled();
  assert.equal(f.connects(), 1);
  assert.equal(f.streams(), 1);
  assert.equal(f.writes(), 1);
});
void test('batch client wraps malformed requests with sent false before opening a connection', async () => {
  const f = fixture();
  const client = createBatchChannelClient(f.endpoint, destination, seller);
  await assert.rejects(
    client.exchange({ ...request, unknown: true }),
    (error) =>
      error instanceof BatchClientError &&
      !error.sent &&
      error.code === SESSION_CODES.INVALID,
  );
  assert.equal(f.connects(), 0);
  await client.close();
  await client.settled();
});
void test('batch client rejects the authenticated wrong seller and closes the connection before writing', async () => {
  const f = fixture();
  f.connection.remoteId = () => ({ toString: () => '78'.repeat(32) });
  const client = createBatchChannelClient(f.endpoint, destination, seller);
  await assert.rejects(
    client.exchange(request),
    (error) =>
      error instanceof BatchClientError &&
      !error.sent &&
      error.code === PAID_EXECUTION_CODES.PEER,
  );
  await client.close();
  await client.settled();
  assert.equal(f.closes(), 1);
  assert.equal(f.writes(), 0);
  assert.equal(f.streams(), 0);
});
void test('a cancelled late connection is closed without sending or publishing a result', async () => {
  const f = fixture();
  const connected = batchDeferred<BatchConnection>();
  const started = batchDeferred<void>();
  f.endpoint.connect = async () => {
    started.resolve();
    return connected.promise;
  };
  const client = createBatchChannelClient(f.endpoint, destination, seller);
  const controller = new AbortController();
  const rejected = assert.rejects(
    client.exchange(request, controller.signal),
    (error) =>
      error instanceof BatchClientError &&
      !error.sent &&
      error.code === PAID_EXECUTION_CODES.CANCELLED,
  );
  await started.promise;
  controller.abort();
  await rejected;
  connected.resolve(f.connection);
  await client.settled();
  assert.equal(f.closes(), 1);
  assert.equal(f.writes(), 0);
  await client.close();
});
void test('batch client refuses a quote that expired while opening the stream before any write', async () => {
  const f = fixture();
  const source = await paidSource();
  let now = source.now();
  const open = f.connection.openBi.bind(f.connection);
  f.connection.openBi = async () => {
    now = source.paid.quote.offer.expiresAt;
    return open();
  };
  const client = createBatchChannelClient(f.endpoint, destination, seller, {
    now: () => now,
  });
  const opening: BatchChannelRequest = {
    version: BATCH_CHANNEL.version,
    requestId: '12'.repeat(16),
    method: BATCH_METHODS.OPEN,
    params: { payload: 'synthetic opaque opening', quote: source.paid.quote },
  };
  await assert.rejects(
    client.exchange(opening),
    (error) =>
      error instanceof BatchClientError &&
      !error.sent &&
      error.code === PAID_EXECUTION_CODES.EXPIRED,
  );
  assert.equal(f.writes(), 0);
  await client.close();
  await client.settled();
});
