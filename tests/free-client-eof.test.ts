// The end-of-stream check after a complete free response: a byte after it is invalid, but a connection
// that breaks once the whole answer arrived keeps the answer, so a buyer never resends a prompt whose
// answer it already holds. Synthetic stream; no sockets.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';
import { encodeFreeExecutionResponse } from '@gyblos/protocol/free-execution-framing';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';

import { freeSellerFixture } from './support/free-seller';

async function afterAnswer(read: () => Promise<number[]>) {
  const source = await freeSellerFixture();
  const request = await source.request();
  const response = encodeFreeExecutionResponse({
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
    result: {
      text: 'answer',
      usage: { inputTokens: 4, outputTokens: 2 },
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
  });
  const connection = {
    remoteId: () => ({ toString: () => source.options.nodeId }),
    paths: () => [{ isSelected: true, isIp: true, isRelay: false }],
    close: () => {},
    openBi: async () => ({
      send: { writeAll: async () => {}, finish: async () => {} },
      recv: {
        readExact: async (length: number) => [
          ...(length === 4 ? response.subarray(0, 4) : response.subarray(4)),
        ],
        read,
      },
    }),
  } as unknown as Connection;
  const endpoint = {
    id: () => ({ toString: () => request.quote.offer.buyerNodeId }),
    connect: async () => connection,
  } as unknown as Endpoint;
  const remote = {
    id: () => ({ toString: () => source.options.nodeId }),
    relayUrl: () => null,
  } as unknown as EndpointAddr;
  const client = createFreeExecutionClient(endpoint, remote, source.options, {
    now: () => request.quote.offer.issuedAt,
  });
  try {
    return await client.execute(request);
  } finally {
    await client.settled();
  }
}

void test('a connection that breaks after the whole answer keeps the answer', async () => {
  const result = await afterAnswer(async () => {
    throw new Error('ReadError(ConnectionLost)');
  });
  assert.equal(result.text, 'answer');
});

void test('a byte after the answer is still invalid', async () => {
  await assert.rejects(
    afterAnswer(async () => [1]),
    { code: FREE_EXECUTION_CODES.INVALID },
  );
});
