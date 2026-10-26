// Offline free transport regressions with synthetic quotes and bounded stream doubles.
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
import { signOfferV2 } from '@gyblos/protocol/offer-v2';

import { freeSellerFixture } from './support/free-seller.js';

async function fixture(
  options: { relayOnly?: boolean; requestMs?: number } = {},
) {
  const source = await freeSellerFixture();
  const request = await source.request();
  let writes = 0;
  let closes = 0;
  let bodyReads = 0;
  let remoteId = source.options.nodeId;
  let relay: string | null = null;
  let connect = async () => connection;
  let write = async () => {};
  let frame = encodeFreeExecutionResponse({
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
    remoteId: () => ({ toString: () => remoteId }),
    paths: () => [{ isSelected: true, isIp: true, isRelay: false }],
    close: () => {
      closes++;
    },
    openBi: async () => ({
      send: {
        writeAll: async () => {
          writes++;
          await write();
        },
        finish: async () => {},
      },
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
  const remote = {
    id: () => ({ toString: () => source.options.nodeId }),
    relayUrl: () => relay,
  } as unknown as EndpointAddr;
  const api = await import('@gyblos/transport-iroh/free-client');
  const client = api.createFreeExecutionClient(
    endpoint,
    remote,
    {
      owner: source.options.owner,
      nodeId: source.options.nodeId,
    },
    { now: source.options.now, requestMs: 100, ...options },
  );
  return {
    source,
    request,
    client,
    writes: () => writes,
    closes: () => closes,
    bodyReads: () => bodyReads,
    setRelay: (value: string) => {
      relay = value;
    },
    setRemote: (value: string) => {
      remoteId = value;
    },
    setConnect: (value: typeof connect) => {
      connect = value;
    },
    setWrite: (value: typeof write) => {
      write = value;
    },
    setFrame: (value: Uint8Array) => {
      frame = value;
    },
    connection,
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
  await assert.rejects(item.client.execute(item.request), {
    code: FREE_EXECUTION_CODES.PEER,
    sent: false,
  });
  assert.equal(item.writes(), 0);
});
void test('free client rechecks expiry after dialing', async () => {
  const item = await fixture();
  item.setConnect(async () => {
    item.source.setNow(item.request.quote.offer.expiresAt);
    return item.connection;
  });
  await assert.rejects(item.client.execute(item.request), {
    code: FREE_EXECUTION_CODES.EXPIRED,
    sent: false,
  });
  assert.equal(item.writes(), 0);
});
void test('free client marks partial failed writes as sent and cannot retry', async () => {
  const item = await fixture();
  item.setWrite(async () => {
    throw new Error('synthetic partial write');
  });
  await assert.rejects(item.client.execute(item.request), { sent: true });
  await assert.rejects(item.client.execute(item.request));
  assert.equal(item.writes(), 1);
});
void test('free client cuts oversized prefixes before reading the body', async () => {
  const item = await fixture();
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, FREE_EXECUTION.responseBytes + 1);
  item.setFrame(prefix);
  await assert.rejects(item.client.execute(item.request), {
    code: FREE_EXECUTION_CODES.LIMIT,
    sent: true,
  });
  assert.equal(item.bodyReads(), 0);
});
void test('free client cancels a slow dial and closes a late connection without sending', async () => {
  const item = await fixture();
  let resolve = (_connection: Connection) => {};
  item.setConnect(
    () =>
      new Promise<Connection>((done) => {
        resolve = done;
      }),
  );
  const controller = new AbortController();
  const operation = item.client.execute(item.request, controller.signal);
  await new Promise((done) => setTimeout(done, 10));
  controller.abort();
  await assert.rejects(operation, {
    code: FREE_EXECUTION_CODES.CANCELLED,
    sent: false,
  });
  resolve(item.connection);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(item.writes(), 0);
  assert.equal(item.closes(), 1);
});

void test('free client checks buyer binding and signature before sending', async () => {
  const wrongBuyer = await fixture();
  const wrongQuote = await signOfferV2(
    { ...wrongBuyer.request.quote.offer, buyerNodeId: 'a'.repeat(64) },
    wrongBuyer.source.source.ownerSigner,
  );
  await assert.rejects(
    wrongBuyer.client.execute({ ...wrongBuyer.request, quote: wrongQuote }),
    { code: FREE_EXECUTION_CODES.PEER, sent: false },
  );
  assert.equal(wrongBuyer.writes(), 0);
  const forged = await fixture();
  await assert.rejects(
    forged.client.execute({
      ...forged.request,
      quote: {
        ...forged.request.quote,
        signature: Buffer.alloc(64).toString('base64'),
      },
    }),
    { code: FREE_EXECUTION_CODES.SIGNATURE, sent: false },
  );
  assert.equal(forged.writes(), 0);
});
void test('free client refuses a paid quote and a mismatched selection before sending', async () => {
  const paid = await fixture();
  await assert.rejects(
    paid.client.execute({
      ...paid.request,
      quote: {
        ...paid.request.quote,
        offer: {
          ...paid.request.quote.offer,
          maxAtomic: '1',
          prices: {
            ...paid.request.quote.offer.prices,
            inputAtomicPerMtok: '1',
          },
        },
      },
    }),
    { code: FREE_EXECUTION_CODES.NOT_FREE, sent: false },
  );
  assert.equal(paid.writes(), 0);
  const changed = await fixture();
  await assert.rejects(
    changed.client.execute({
      ...changed.request,
      input: {
        ...changed.request.input,
        selection: { ...changed.request.input.selection, modelId: 'other' },
      },
    }),
    { code: FREE_EXECUTION_CODES.BINDING, sent: false },
  );
  assert.equal(changed.writes(), 0);
});
void test('free client correlates remote errors and rejects mismatched responses', async () => {
  const remote = await fixture();
  remote.setFrame(
    encodeFreeExecutionResponse({
      version: FREE_EXECUTION.version,
      requestId: remote.request.requestId,
      requestDigest: await freeExecutionDigest(remote.request),
      error: { code: FREE_EXECUTION_CODES.BUSY },
    }),
  );
  await assert.rejects(remote.client.execute(remote.request), {
    code: FREE_EXECUTION_CODES.BUSY,
    remote: true,
    sent: true,
  });
  const changed = await fixture();
  changed.setFrame(
    encodeFreeExecutionResponse({
      version: FREE_EXECUTION.version,
      requestId: 'f'.repeat(32),
      requestDigest: await freeExecutionDigest(changed.request),
      error: { code: FREE_EXECUTION_CODES.BUSY },
    }),
  );
  await assert.rejects(changed.client.execute(changed.request), {
    code: FREE_EXECUTION_CODES.BINDING,
    remote: false,
    sent: true,
  });
});
void test('free client exposes settlement until a cancelled native write actually finishes', async () => {
  const item = await fixture();
  let writing = () => {};
  const began = new Promise<void>((resolve) => {
    writing = resolve;
  });
  let release = () => {};
  item.setWrite(async () => {
    writing();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const controller = new AbortController();
  const operation = item.client.execute(item.request, controller.signal);
  await began;
  controller.abort();
  await assert.rejects(operation, { sent: true });
  let settled = false;
  const finished = item.client.settled().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  release();
  await finished;
  assert.equal(settled, true);
});

void test('free client rejects unapproved relays and relay-only without a relay before sending', async () => {
  const unapproved = await fixture();
  unapproved.setRelay('https://unapproved.example/');
  await assert.rejects(unapproved.client.execute(unapproved.request), {
    code: FREE_EXECUTION_CODES.PEER,
    sent: false,
  });
  assert.equal(unapproved.writes(), 0);
  const required = await fixture({ relayOnly: true });
  await assert.rejects(required.client.execute(required.request), {
    code: FREE_EXECUTION_CODES.PEER,
    sent: false,
  });
  assert.equal(required.writes(), 0);
});
void test('free client cuts slow frames at the absolute deadline and suppresses late writes', async () => {
  const item = await fixture({ requestMs: 30 });
  let release = () => {};
  item.setWrite(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(item.client.execute(item.request), {
    code: FREE_EXECUTION_CODES.TIMEOUT,
    sent: true,
  });
  release();
  await item.client.settled();
  assert.equal(item.writes(), 1);
  assert.equal(item.closes(), 1);
});
