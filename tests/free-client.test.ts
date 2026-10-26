// Offline free transport regressions with synthetic quotes and bounded stream doubles.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { FREE_EXECUTION_CODES, FREE_EXECUTION } from '@gyblos/protocol/constants';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';
import { encodeFreeExecutionResponse } from '@gyblos/protocol/free-execution-framing';

import { freeSellerFixture } from './support/free-seller.js';

async function fixture() {
  const source = await freeSellerFixture();
  const request = await source.request();
  let writes = 0;
  let closes = 0;
  let bodyReads = 0;
  let remoteId = source.options.nodeId;
  let connect = async () => connection;
  let write = async () => {};
  let frame = encodeFreeExecutionResponse({
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
    result: { text: 'answer', usage: { inputTokens: 4, outputTokens: 2 }, finishReason: 'stop' },
  });
  const connection = {
    remoteId: () => ({ toString: () => remoteId }),
    paths: () => [{ isSelected: true, isIp: true, isRelay: false }],
    close: () => { closes++; },
    openBi: async () => ({
      send: { writeAll: async () => { writes++; await write(); }, finish: async () => {} },
      recv: {
        readExact: async (length: number) => {
          if (length === 4) return [...frame.subarray(0, 4)];
          bodyReads++;
          return [...frame.subarray(4)];
        },
        read: async () => [],
      },
    }),
  } as unknown as Connection;
  const endpoint = {
    id: () => ({ toString: () => request.quote.offer.buyerNodeId }),
    connect: async () => connect(),
  } as unknown as Endpoint;
  const remote = { id: () => ({ toString: () => source.options.nodeId }) } as unknown as EndpointAddr;
  const api = await import('@gyblos/transport-iroh/free-client');
  const client = api.createFreeExecutionClient(endpoint, remote, {
    owner: source.options.owner, nodeId: source.options.nodeId,
  }, { now: source.options.now, requestMs: 100 });
  return { source, request, client, writes: () => writes, closes: () => closes, bodyReads: () => bodyReads,
    setRemote: (value: string) => { remoteId = value; },
    setConnect: (value: typeof connect) => { connect = value; },
    setWrite: (value: typeof write) => { write = value; },
    setFrame: (value: Uint8Array) => { frame = value; }, connection,
  };
}
void test('free client executes and correlates a complete bounded response', async () => {
  const item = await fixture();
  assert.equal((await item.client.execute(item.request)).text, 'answer');
  assert.equal(item.writes(), 1);
  assert.equal(item.closes(), 1);
});
void test('free client rejects another authenticated peer before sending', async () => {
  const item = await fixture();
  item.setRemote('a'.repeat(64));
  await assert.rejects(item.client.execute(item.request), { code: FREE_EXECUTION_CODES.PEER, sent: false });
  assert.equal(item.writes(), 0);
});
void test('free client rechecks expiry after dialing', async () => {
  const item = await fixture();
  item.setConnect(async () => {
    item.source.setNow(item.request.quote.offer.expiresAt);
    return item.connection;
  });
  await assert.rejects(item.client.execute(item.request), { code: FREE_EXECUTION_CODES.EXPIRED, sent: false });
  assert.equal(item.writes(), 0);
});
void test('free client marks partial failed writes as sent and cannot retry', async () => {
  const item = await fixture();
  item.setWrite(async () => { throw new Error('synthetic partial write'); });
  await assert.rejects(item.client.execute(item.request), { sent: true });
  await assert.rejects(item.client.execute(item.request));
  assert.equal(item.writes(), 1);
});
void test('free client cuts oversized prefixes before reading the body', async () => {
  const item = await fixture();
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, FREE_EXECUTION.responseBytes + 1);
  item.setFrame(prefix);
  await assert.rejects(item.client.execute(item.request), { code: FREE_EXECUTION_CODES.LIMIT, sent: true });
  assert.equal(item.bodyReads(), 0);
});
void test('free client cancels a slow dial and closes a late connection without sending', async () => {
  const item = await fixture();
  let resolve = (_connection: Connection) => {};
  item.setConnect(() => new Promise<Connection>((done) => { resolve = done; }));
  const controller = new AbortController();
  const operation = item.client.execute(item.request, controller.signal);
  await new Promise((done) => setTimeout(done, 10));
  controller.abort();
  await assert.rejects(operation, { code: FREE_EXECUTION_CODES.CANCELLED, sent: false });
  resolve(item.connection);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(item.writes(), 0);
  assert.equal(item.closes(), 1);
});
