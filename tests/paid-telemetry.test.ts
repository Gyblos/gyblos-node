// Verifies the paid adapter shares observational telemetry without changing financial outcomes.
// All quotes, engine output and settlements are synthetic; no transport, files or chain are used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { toTelemetryRecord } from '@gyblos/core/telemetry';
import {
  ENGINE_ERROR_CODES,
  ENGINE_KINDS,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  EXECUTION_ROUTES,
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
  type ExecutionRoute,
  type TelemetryEvent,
} from '@gyblos/protocol/telemetry';

import { paidSellerFixture, paymentError } from './support/paid-seller';

async function fixture() {
  const seller = await paidSellerFixture();
  const events: TelemetryEvent[] = [];
  seller.options.telemetry = {
    engineKind: ENGINE_KINDS.OLLAMA,
    now: seller.options.now,
    sink: {
      emit: (event) => {
        toTelemetryRecord(event);
        events.push(event);
      },
      flush: async () => {},
      close: async () => ({
        emitted: events.length,
        dropped: 0,
        failed: false,
      }),
    },
  };
  return { seller, events };
}

void test('paid completion emits one lifecycle and only its confirmed charge', async () => {
  const { seller, events } = await fixture();
  const response = (await seller.execute(await seller.request())).terminal;
  assert.deepEqual(
    events.map(({ type }) => type),
    [
      TELEMETRY_EVENTS.REQUEST_RECEIVED,
      TELEMETRY_EVENTS.FIRST_TOKEN,
      TELEMETRY_EVENTS.COMPLETED,
      TELEMETRY_EVENTS.CHARGED,
    ],
  );
  const charge = events.find(
    (event) => event.type === TELEMETRY_EVENTS.CHARGED,
  );
  assert.equal(
    charge?.amountAtomic,
    response.payment?.settlement?.chargedAtomic,
  );
  assert.equal(charge?.feeAtomic, response.payment?.settlement?.feeAtomic);
  assert.equal(seller.engineCalls.length, 1);
  assert.equal(seller.payment.calls.settle.length, 1);
  const text = JSON.stringify(events);
  assert.equal(text.includes('Hello'), false);
  assert.equal(text.includes('Hi.'), false);
  assert.equal(text.includes('payload'), false);
});

void test('paid engine interruption reports the shared stop category and verified partial charge', async () => {
  const { seller, events } = await fixture();
  seller.setScript({
    deltas: ['Hi'],
    error: new EngineError(ENGINE_ERROR_CODES.INTERRUPTED),
  });
  const response = (await seller.execute(await seller.request())).terminal;
  assert.equal(
    response.error?.code,
    PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  );
  const failed = events.find((event) => event.type === TELEMETRY_EVENTS.FAILED);
  assert.equal(failed?.code, FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE);
  assert.equal(failed?.reason, FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED);
  assert.equal(failed?.delivered?.outputTokens, 2);
  const charge = events.find(
    (event) => event.type === TELEMETRY_EVENTS.CHARGED,
  );
  assert.equal(charge?.amountAtomic, '8');
});

void test('paid busy refusal emits no generation or charge observation', async () => {
  const { seller, events } = await fixture();
  seller.setBusy(true);
  await seller.execute(await seller.request());
  assert.deepEqual(
    events.map(({ type }) => type),
    [TELEMETRY_EVENTS.REQUEST_RECEIVED, TELEMETRY_EVENTS.REFUSED],
  );
  const refused = events.find(
    (event) => event.type === TELEMETRY_EVENTS.REFUSED,
  );
  assert.equal(refused?.refusal, TELEMETRY_REFUSALS.SELLER_BUSY);
  assert.equal(seller.payment.calls.admit.length, 0);
});

void test('an unverified paid peer emits no trusted seller observation', async () => {
  const { seller, events } = await fixture();
  const response = await seller.service.stream(
    await seller.request(),
    'e'.repeat(64),
    new AbortController().signal,
    async () => {},
  );
  assert.equal(response.error?.code, PAID_EXECUTION_CODES.PEER);
  assert.deepEqual(events, []);
  assert.equal(seller.payment.calls.admit.length, 0);
});

void test('pending financial settlement is never emitted as CHARGED', async () => {
  const { seller, events } = await fixture();
  seller.payment.control.settle = {
    kind: 'fail',
    error: paymentError(PAYMENT_ERROR_CODES.UNAVAILABLE),
  };
  const response = (await seller.execute(await seller.request())).terminal;
  assert.equal(response.payment?.pending?.chargedAtomic, '10');
  assert.deepEqual(
    events.map(({ type }) => type),
    [
      TELEMETRY_EVENTS.REQUEST_RECEIVED,
      TELEMETRY_EVENTS.FIRST_TOKEN,
      TELEMETRY_EVENTS.COMPLETED,
    ],
  );
});

void test('paid route and engine duration reach the existing shared telemetry sink', async () => {
  const { seller, events } = await fixture();
  const generate = seller.options.engine.generate;
  seller.options.engine.generate = async (input) => {
    const result = await generate(input);
    return {
      ...result,
      usage: { ...result.usage, outputDurationNs: 3_000_000 },
    };
  };
  let route: ExecutionRoute = EXECUTION_ROUTES.RELAY;
  const request = await seller.request();
  await seller.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async () => {
      route = EXECUTION_ROUTES.DIRECT;
    },
    () => route,
  );
  const completed = events.find(
    (event) => event.type === TELEMETRY_EVENTS.COMPLETED,
  );
  assert.equal(completed?.generationMs, 3);
  assert.deepEqual(completed?.path, {
    route: EXECUTION_ROUTES.DIRECT,
    routeChanged: true,
  });
});

void test('a broken paid telemetry sink never changes inference or settlement', async () => {
  const { seller } = await fixture();
  let calls = 0;
  seller.options.telemetry!.sink.emit = () => {
    calls++;
    throw new Error('synthetic observer failure');
  };
  const response = (await seller.execute(await seller.request())).terminal;
  assert.ok(calls > 0);
  assert.equal(response.result?.text, 'Hi.');
  assert.equal(response.payment?.settlement?.chargedAtomic, '10');
  assert.equal(seller.engineCalls.length, 1);
});
