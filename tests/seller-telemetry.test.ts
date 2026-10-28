// Seller execution telemetry uses synthetic quotes and engines only; no publication, payments or real homes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { toTelemetryRecord } from '@gyblos/core/telemetry';
import { createSellerFreeExecution } from '@gyblos/node/free-execution';
import { DECLARED_METER } from '@gyblos/node/free-meter';
import {
  CONTROL_METERING_MODES,
  ENGINE_ERROR_CODES,
  ENGINE_KINDS,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
} from '@gyblos/protocol/telemetry';

import { freeSellerFixture, freeSellerSignal } from './support/free-seller';
import {
  freeStreamSellerFixture,
  streamResult,
} from './support/free-stream-seller';
import { localTelemetry } from './support/local-telemetry';

void test('seller emits one request and completion with sizes and metering but no content', async () => {
  const source = await freeSellerFixture();
  const telemetry = localTelemetry();
  const service = createSellerFreeExecution({
    ...source.options,
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
  });
  source.setRun(async () => {
    telemetry.advance(12);
    return streamResult();
  });
  const request = await source.request();
  const response = await service.respond(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
  );
  assert.ok(response.result);
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [TELEMETRY_EVENTS.REQUEST_RECEIVED, TELEMETRY_EVENTS.COMPLETED],
  );
  const completed = telemetry.events[1];
  assert.equal(completed?.type, TELEMETRY_EVENTS.COMPLETED);
  if (completed?.type !== TELEMETRY_EVENTS.COMPLETED) assert.fail();
  assert.equal(completed.totalMs, 12);
  assert.equal(completed.meteringMode, CONTROL_METERING_MODES.RECOUNTED);
  assert.deepEqual(completed.sizes, {
    inputBytes: 5,
    inputChars: 5,
    outputBytes: 6,
    outputChars: 6,
  });
  assert.deepEqual(completed.usage, {
    inputTokens: 4,
    outputTokens: 2,
    reasoningTokens: null,
  });
  for (const event of telemetry.events)
    assert.deepEqual(toTelemetryRecord(event), event);
  assert.doesNotMatch(
    JSON.stringify(telemetry.events),
    /hello|answer|signature|endpoint/,
  );
});
void test('seller streaming observes first successfully delivered fragment exactly once', async () => {
  const source = await freeStreamSellerFixture();
  const telemetry = localTelemetry();
  const service = createSellerFreeExecution({
    ...source.options,
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
  });
  const request = await source.request();
  await service.stream(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
    async () => {
      telemetry.advance(3);
    },
  );
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [
      TELEMETRY_EVENTS.REQUEST_RECEIVED,
      TELEMETRY_EVENTS.FIRST_TOKEN,
      TELEMETRY_EVENTS.COMPLETED,
    ],
  );
});
void test('seller maps busy and cap refusals without invoking an engine', async () => {
  for (const [busy, caps, refusal] of [
    [
      true,
      { dailyTokenCap: 100, perBuyerCap: 50 },
      TELEMETRY_REFUSALS.SELLER_BUSY,
    ],
    [false, { dailyTokenCap: 1, perBuyerCap: 1 }, TELEMETRY_REFUSALS.DAILY_CAP],
    [false, {dailyTokenCap:100,perBuyerCap:1},TELEMETRY_REFUSALS.BUYER_CAP],
  ] as const) {
    const source = await freeSellerFixture(caps);
    const telemetry = localTelemetry();
    source.setBusy(busy);
    const service = createSellerFreeExecution({
      ...source.options,
      telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
    });
    const request = await source.request();
    await service.respond(
      request,
      request.quote.offer.buyerNodeId,
      freeSellerSignal(),
    );
    assert.equal(source.calls(), 0);
    assert.deepEqual(
      telemetry.events.map((event) => event.type),
      [TELEMETRY_EVENTS.REQUEST_RECEIVED, TELEMETRY_EVENTS.REFUSED],
    );
    assert.equal(
      telemetry.events[1]?.type === TELEMETRY_EVENTS.REFUSED
        ? telemetry.events[1].refusal
        : null,
      refusal,
    );
  }
});
void test('seller emits static failure on engine rejection and cancellation without a completion', async () => {
  const source = await freeStreamSellerFixture();
  const telemetry = localTelemetry();
  source.setGenerate(async (input) => {
    await input.onText?.('an');
    throw new EngineError(ENGINE_ERROR_CODES.QUOTA_EXHAUSTED);
  });
  const service = createSellerFreeExecution({
    ...source.options,
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
  });
  const request = await source.request();
  await service.stream(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
    async () => {},
  );
  assert.deepEqual(
    telemetry.events.map((event) => event.type),
    [
      TELEMETRY_EVENTS.REQUEST_RECEIVED,
      TELEMETRY_EVENTS.FIRST_TOKEN,
      TELEMETRY_EVENTS.FAILED,
    ],
  );
  const failed = telemetry.events[2];
  assert.equal(
    failed?.type === TELEMETRY_EVENTS.FAILED ? failed.code : null,
    FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  );
});
void test('seller never observes unauthenticated peer claims', async () => {
  const source = await freeSellerFixture();
  const telemetry = localTelemetry();
  const service = createSellerFreeExecution({
    ...source.options,
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
  });
  await service.respond(
    await source.request(),
    'ff'.repeat(32),
    freeSellerSignal(),
  );
  assert.deepEqual(telemetry.events, []);
  assert.equal(source.calls(), 0);
});
void test('seller declared completion records provider usage rather than the admission reservation', async () => {
  const source = await freeSellerFixture(
    { dailyTokenCap: 1000, perBuyerCap: 1000 },
    { meter: DECLARED_METER },
  );
  const telemetry = localTelemetry();
  const service = createSellerFreeExecution({
    ...source.options,
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OPENAI },
  });
  const request = await source.request();
  await service.respond(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
  );
  const completed = telemetry.events.find(
    (event) => event.type === TELEMETRY_EVENTS.COMPLETED,
  );
  assert.ok(completed?.type === TELEMETRY_EVENTS.COMPLETED);
  assert.equal(completed.meteringMode, CONTROL_METERING_MODES.DECLARED);
  assert.equal(completed.usage.inputTokens, 4);
});
void test('seller cancellation is a single failed terminal and throwing telemetry cannot change execution', async () => {
  const source = await freeStreamSellerFixture();
  const telemetry = localTelemetry();
  const controller = new AbortController();
  const service = createSellerFreeExecution({
    ...source.options,
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
  });
  const request = await source.request();
  const response = await service.stream(
    request,
    request.quote.offer.buyerNodeId,
    controller.signal,
    async () => {
      controller.abort();
    },
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.CANCELLED);
  assert.equal(
    telemetry.events.filter((event) => event.type === TELEMETRY_EVENTS.FAILED)
      .length,
    1,
  );
  assert.equal(
    telemetry.events.some((event) => event.type === TELEMETRY_EVENTS.COMPLETED),
    false,
  );
  const healthy = await freeSellerFixture();
  const broken = createSellerFreeExecution({
    ...healthy.options,
    telemetry: {
      engineKind: ENGINE_KINDS.OLLAMA,
      sink: {
        ...telemetry.sink,
        emit() {
          throw new Error('PRIVATE-MARKER');
        },
      },
      now() {
        throw new Error('PRIVATE-MARKER');
      },
    },
  });
  const next = await healthy.request();
  assert.ok(
    (
      await broken.respond(
        next,
        next.quote.offer.buyerNodeId,
        freeSellerSignal(),
      )
    ).result,
  );
  assert.equal(healthy.calls(), 1);
});
void test('seller reports stale readiness as an engine-not-ready refusal before generation', async () => {
  const source = await freeSellerFixture();
  const telemetry = localTelemetry();
  const service = createSellerFreeExecution({
    ...source.options,
    readiness: () => ({ ...source.options.readiness(), validUntil: 0 }),
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
  });
  const request = await source.request();
  await service.respond(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
  );
  assert.equal(source.calls(), 0);
  const refused = telemetry.events.find(
    (event) => event.type === TELEMETRY_EVENTS.REFUSED,
  );
  assert.equal(refused?.refusal, TELEMETRY_REFUSALS.ENGINE_NOT_READY);
});
