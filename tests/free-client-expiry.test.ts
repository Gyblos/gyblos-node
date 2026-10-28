// Exercises time passing during the final asynchronous quote authentication, without sockets or clocks of our own.
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

async function expiryFixture(offset: number) {
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
  let clock = request.quote.offer.issuedAt;
  let streamOpened = false;
  let advanced = false;
  let writes = 0;
  let writeTime: number | undefined;
  let closes = 0;
  const connection = {
    remoteId: () => ({ toString: () => source.options.nodeId }),
    paths: () => [{ isSelected: true, isIp: true, isRelay: false }],
    close: () => {
      closes++;
    },
    openBi: async () => {
      streamOpened = true;
      return {
        send: {
          writeAll: async () => {
            writes++;
            writeTime = clock;
          },
          finish: async () => {},
        },
        recv: {
          readExact: async (length: number) => [
            ...(length === 4 ? response.subarray(0, 4) : response.subarray(4)),
          ],
          read: async () => [],
        },
      };
    },
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
    now: () => {
      const observed = clock;
      if (streamOpened && !advanced)
        queueMicrotask(() => {
          clock = request.quote.offer.expiresAt + offset;
          advanced = true;
        });
      return observed;
    },
  });
  return {
    request,
    client,
    writes: () => writes,
    closes: () => closes,
    writeTime: () => writeTime,
    advanced: () => advanced,
  };
}
async function expiredDuringAuthentication(offset: number) {
  const item = await expiryFixture(offset);
  try {
    await assert.rejects(item.client.execute(item.request), {
      code: FREE_EXECUTION_CODES.EXPIRED,
      sent: false,
      remote: false,
    });
    assert.equal(item.advanced(), true);
    assert.equal(item.writes(), 0);
    assert.equal(item.closes(), 1);
  } finally {
    await item.client.settled();
  }
}
void test('free client refuses exact expiry reached during final signature verification before sending', async () => {
  await expiredDuringAuthentication(0);
});
void test('free client refuses expiry passed during final signature verification before sending', async () => {
  await expiredDuringAuthentication(1);
});
void test('free client still sends when final signature verification finishes just before expiry', async () => {
  const item = await expiryFixture(-1);
  try {
    assert.equal((await item.client.execute(item.request)).text, 'answer');
    assert.equal(item.advanced(), true);
    assert.equal(item.writeTime(), item.request.quote.offer.expiresAt - 1);
    assert.equal(item.writes(), 1);
    assert.equal(item.closes(), 1);
  } finally {
    await item.client.settled();
  }
});
