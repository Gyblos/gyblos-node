// Buyer lifecycle observations use injected execution and synthetic signed quotes, never payments or live engines.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { FreeBuyerError } from '@gyblos/buyer/free-chat';
import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { toTelemetryRecord } from '@gyblos/core/telemetry';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
} from '@gyblos/protocol/telemetry';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { freeSellerFixture } from './support/free-seller';
import { streamResult } from './support/free-stream-seller';
import { localTelemetry } from './support/local-telemetry';

async function fixture() {
  const source = await freeSellerFixture();
  const request = await source.request();
  const telemetry = localTelemetry();
  return {
    request: {
      ...request,
      input: {
        messages: request.input.messages,
        maxTokens: request.input.maxTokens,
      },
    },
    telemetry,
    dependencies: {
      telemetry: {
        ...telemetry,
        buyerNodeId: request.quote.offer.buyerNodeId,
        selection: request.input.selection,
      },
      select: async () => ({
        nodeId: request.quote.offer.nodeId,
        quote: request.quote,
      }),
      execute: async () => streamResult(),
    },
  };
}
void test('buyer emits request and verified completion with unknown engine and no content', async () => {
  const { request, telemetry, dependencies } = await fixture();
  await executeBuyerFree(request.input, dependencies);
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [TELEMETRY_EVENTS.REQUEST_RECEIVED, TELEMETRY_EVENTS.COMPLETED],
  );
  assert.equal(telemetry.events[0]?.engineKind, null);
  for (const event of telemetry.events)
    assert.deepEqual(toTelemetryRecord(event), event);
  assert.doesNotMatch(
    JSON.stringify(telemetry.events),
    /hello|answer|signature|endpoint/,
  );
});
void test('buyer records refused unsent attempt then successful failover exactly once per attempt', async () => {
  const { request, telemetry, dependencies } = await fixture();
  let calls = 0;
  let selected = 0;
  await executeBuyerFree(request.input, {
    ...dependencies,
    select: async () => ({
      nodeId: (++selected).toString(16).padStart(64, '0'),
      quote: request.quote,
    }),
    execute: async () => {
      if (++calls === 1)
        throw new FreeClientError(FREE_EXECUTION_CODES.INTERNAL, false);
      return streamResult();
    },
  });
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [
      TELEMETRY_EVENTS.REQUEST_RECEIVED,
      TELEMETRY_EVENTS.REFUSED,
      TELEMETRY_EVENTS.REQUEST_RECEIVED,
      TELEMETRY_EVENTS.COMPLETED,
    ],
  );
  const refused = telemetry.events[1];
  assert.equal(
    refused?.type === TELEMETRY_EVENTS.REFUSED ? refused.refusal : null,
    TELEMETRY_REFUSALS.CONNECT_FAILED,
  );
});
void test('buyer emits unserved only when selection cannot provide a seller', async () => {
  const { request, telemetry, dependencies } = await fixture();
  await assert.rejects(
    executeBuyerFree(request.input, {
      ...dependencies,
      select: async () => {
        throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      },
    }),
  );
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [TELEMETRY_EVENTS.UNSERVED],
  );
  assert.equal(telemetry.events[0]?.requestId, null);
});
void test('buyer sent failure never retries and emits one failure without unserved', async () => {
  const { request, telemetry, dependencies } = await fixture();
  let calls = 0;
  await assert.rejects(
    executeBuyerFree(request.input, {
      ...dependencies,
      execute: async () => {
        calls++;
        throw new FreeClientError(FREE_EXECUTION_CODES.ENGINE, true);
      },
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [TELEMETRY_EVENTS.REQUEST_RECEIVED, TELEMETRY_EVENTS.FAILED],
  );
});
void test('buyer first token waits for successful callback and ignores late telemetry', async () => {
  const { request, telemetry, dependencies } = await fixture();
  let late: ((text: string) => Promise<void>) | undefined;
  await executeBuyerFree(
    request.input,
    {
      ...dependencies,
      execute: async (_winner, _request, _signal, onDelta) => {
        late = onDelta;
        await onDelta?.('an');
        await onDelta?.('swer');
        return streamResult();
      },
    },
    undefined,
    async () => {},
  );
  await late?.('late');
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [
      TELEMETRY_EVENTS.REQUEST_RECEIVED,
      TELEMETRY_EVENTS.FIRST_TOKEN,
      TELEMETRY_EVENTS.COMPLETED,
    ],
  );
});
void test('buyer callback failure preserves no-retry and does not claim first token or completion', async () => {
  const { request, telemetry, dependencies } = await fixture();
  let calls = 0;
  const failure = new Error('PRIVATE-MARKER');
  await assert.rejects(
    executeBuyerFree(
      request.input,
      {
        ...dependencies,
        execute: async (_winner, _request, _signal, onDelta) => {
          calls++;
          await onDelta?.('an');
          return streamResult();
        },
      },
      undefined,
      async () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [TELEMETRY_EVENTS.REQUEST_RECEIVED, TELEMETRY_EVENTS.FAILED],
  );
  assert.doesNotMatch(JSON.stringify(telemetry.events), /PRIVATE-MARKER/);
});
void test('buyer cancellation during execution records one static failure and does not retry', async () => {
  const { request, telemetry, dependencies } = await fixture();
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(
    executeBuyerFree(
      request.input,
      {
        ...dependencies,
        execute: async () => {
          calls++;
          controller.abort();
          throw new Error('PRIVATE-MARKER');
        },
      },
      controller.signal,
    ),
  );
  assert.equal(calls, 1);
  const failures = telemetry.events.filter(
    (event) => event.type === TELEMETRY_EVENTS.FAILED,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.code, FREE_EXECUTION_CODES.CANCELLED);
});
void test('buyer telemetry exceptions cannot prevent success or release of local admission', async () => {
  const { request, telemetry, dependencies } = await fixture();
  let released = 0;
  const output = await executeBuyerFree(request.input, {
    ...dependencies,
    enter: () => () => {
      released++;
    },
    telemetry: {
      ...dependencies.telemetry,
      sink: {
        ...telemetry.sink,
        emit() {
          throw new Error('PRIVATE-MARKER');
        },
      },
    },
  });
  assert.equal(output.text, 'answer');
  assert.equal(released, 1);
});
void test('buyer records verified remote busy and cap refusals without enabling retry after send', async () => {
  for (const [code, refusal] of [
    [FREE_EXECUTION_CODES.BUSY, TELEMETRY_REFUSALS.SELLER_BUSY],
    [FREE_EXECUTION_CODES.DAILY_CAP, TELEMETRY_REFUSALS.DAILY_CAP],
    [FREE_EXECUTION_CODES.BUYER_CAP, TELEMETRY_REFUSALS.BUYER_CAP],
  ] as const) {
    const { request, telemetry, dependencies } = await fixture();
    let calls = 0;
    await assert.rejects(
      executeBuyerFree(request.input, {
        ...dependencies,
        execute: async () => {
          calls++;
          throw new FreeClientError(code, true, true);
        },
      }),
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      telemetry.events.map((event) => event.type),
      [TELEMETRY_EVENTS.REQUEST_RECEIVED, TELEMETRY_EVENTS.REFUSED],
    );
    const terminal = telemetry.events[1];
    assert.equal(
      terminal?.type === TELEMETRY_EVENTS.REFUSED ? terminal.refusal : null,
      refusal,
    );
  }
});
void test('buyer cancelled selection is not counted as unavailable supply', async () => {
  const { request, telemetry, dependencies } = await fixture();
  const controller = new AbortController();
  await assert.rejects(
    executeBuyerFree(
      request.input,
      {
        ...dependencies,
        select: async () => {
          controller.abort();
          throw controller.signal.reason;
        },
      },
      controller.signal,
    ),
  );
  assert.deepEqual(telemetry.events, []);
});
