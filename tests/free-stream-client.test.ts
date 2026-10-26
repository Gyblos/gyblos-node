// Exercises streaming over bounded SDK doubles, preserving the shared client's conservative sent state.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_STREAM,
} from '@gyblos/protocol/constants';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';
import { encodeFreeStreamEvent } from '@gyblos/protocol/free-stream';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';

import { freeSellerFixture } from './support/free-seller.js';

async function fixture(
  options: {
    writeFailure?: boolean;
    truncate?: boolean;
    cancel?: AbortController;
  } = {},
) {
  const source = await freeSellerFixture();
  const request = await source.request();
  const header = {
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
  };
  const result = {
    text: 'answer',
    usage: { inputTokens: 4, outputTokens: 2 },
    finishReason: ENGINE_DONE_REASONS.STOP,
  };
  const frames = [
    encodeFreeStreamEvent({
      ...header,
      sequence: 0,
      type: FREE_STREAM.events.DELTA,
      text: 'an',
    }),
    encodeFreeStreamEvent({
      ...header,
      sequence: 1,
      type: FREE_STREAM.events.DELTA,
      text: 'swer',
    }),
    encodeFreeStreamEvent({
      ...header,
      sequence: 2,
      type: FREE_STREAM.events.TERMINAL,
      response: { ...header, result },
    }),
  ];
  const all = Buffer.concat(frames);
  let offset = 0;
  let dials = 0;
  let writes = 0;
  let closes = 0;
  let alpn = '';
  const deltas: string[] = [];
  const connection = {
    remoteId: () => ({ toString: () => source.options.nodeId }),
    paths: () => [{ isSelected: true, isIp: true, isRelay: false }],
    close() {
      closes++;
    },
    async openBi() {
      return {
        send: {
          async writeAll() {
            writes++;
            if (options.writeFailure) throw new Error('partial write');
          },
          async finish() {},
        },
        recv: {
          async readExact(size: number) {
            if (
              options.truncate &&
              offset >= frames[0]!.length + frames[1]!.length
            )
              throw new Error('EOF');
            const value = all.subarray(offset, offset + size);
            offset += size;
            return [...value];
          },
          async read() {
            return [...all.subarray(offset)];
          },
        },
      };
    },
  } as unknown as Connection;
  const endpoint = {
    id: () => ({ toString: () => request.quote.offer.buyerNodeId }),
    async connect(_remote: EndpointAddr, protocol: number[]) {
      dials++;
      alpn = Buffer.from(protocol).toString();
      return connection;
    },
  } as unknown as Endpoint;
  const remote = {
    id: () => ({ toString: () => source.options.nodeId }),
    relayUrl: () => null,
  } as unknown as EndpointAddr;
  const client = createFreeExecutionClient(endpoint, remote, source.options, {
    now: source.options.now,
    requestMs: 1000,
    async onDelta(text) {
      await Promise.resolve();
      deltas.push(text);
      options.cancel?.abort();
    },
  });
  return {
    client,
    request,
    deltas,
    counts: () => ({ dials, writes, closes, alpn }),
  };
}
void test('stream client selects the streaming ALPN and delivers ordered deltas before the verified result', async () => {
  const value = await fixture();
  assert.equal((await value.client.execute(value.request)).text, 'answer');
  await value.client.settled();
  assert.deepEqual(value.deltas, ['an', 'swer']);
  assert.equal(value.counts().alpn, FREE_STREAM.alpn);
  assert.equal(value.counts().dials, 1);
});
void test('stream partial write remains possibly sent and is never retried internally', async () => {
  const value = await fixture({ writeFailure: true });
  await assert.rejects(value.client.execute(value.request), { sent: true });
  await value.client.settled();
  assert.equal(value.counts().writes, 1);
  assert.equal(value.counts().dials, 1);
  assert.deepEqual(value.deltas, []);
});
void test('stream truncation after deltas is an error rather than a successful completion', async () => {
  const value = await fixture({ truncate: true });
  await assert.rejects(value.client.execute(value.request), { sent: true });
  await value.client.settled();
  assert.deepEqual(value.deltas, ['an', 'swer']);
});
void test('stream cancellation after first delta closes transport and suppresses later callbacks', async () => {
  const controller = new AbortController();
  const value = await fixture({ cancel: controller });
  await assert.rejects(value.client.execute(value.request, controller.signal), {
    code: FREE_EXECUTION_CODES.CANCELLED,
    sent: true,
  });
  await value.client.settled();
  assert.deepEqual(value.deltas, ['an']);
  assert.ok(value.counts().closes > 0);
});
