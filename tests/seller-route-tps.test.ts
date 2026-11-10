// Seller route and generation-time observations with synthetic probes, engines and sinks; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRouteTracker,
  generationMilliseconds,
  toTelemetryRecord,
} from '@gyblos/core/telemetry';
import { createSellerFreeExecution } from '@gyblos/node/free-execution';
import { ENGINE_ERROR_CODES, ENGINE_KINDS } from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import {
  EXECUTION_ROUTES,
  TELEMETRY_EVENTS,
  type TelemetryEvent,
} from '@gyblos/protocol/telemetry';
import { createOtelTelemetrySink } from '@gyblos/telemetry-otel';
import type { TransportRoute } from '@gyblos/transport-iroh';

import { freeSellerFixture, freeSellerSignal } from './support/free-seller';
import {
  freeStreamSellerFixture,
  streamResult,
} from './support/free-stream-seller';
import { localTelemetry } from './support/local-telemetry';
import { metricExporter, points } from './support/otel-fixture';
import { telemetryEvents } from './support/receipt-fixture';

function probe(...routes: TransportRoute[]) {
  let index = 0;
  return () => routes[Math.min(index++, routes.length - 1)]!;
}
function terminal(events: TelemetryEvent[]) {
  const last = events.at(-1);
  if (
    last?.type !== TELEMETRY_EVENTS.COMPLETED &&
    last?.type !== TELEMETRY_EVENTS.FAILED
  )
    return assert.fail('expected a terminal event');
  return last;
}

void test('route tracker keeps the last known route and reports a mid-execution switch', () => {
  const upgraded = createRouteTracker(probe('iroh-relay', 'iroh-direct'));
  upgraded.sample();
  assert.deepEqual(upgraded.path(), {
    route: EXECUTION_ROUTES.DIRECT,
    routeChanged: true,
  });
  const steady = createRouteTracker(probe('iroh-relay'));
  steady.sample();
  assert.deepEqual(steady.path(), {
    route: EXECUTION_ROUTES.RELAY,
    routeChanged: false,
  });
  // A transient unknown or a closed connection never erases a route already seen.
  let calls = 0;
  const closing = createRouteTracker(() => {
    calls++;
    if (calls === 1) return 'iroh-direct';
    if (calls === 2) return 'unknown';
    throw new Error('closed');
  });
  closing.sample();
  closing.sample();
  assert.deepEqual(closing.path(), {
    route: EXECUTION_ROUTES.DIRECT,
    routeChanged: false,
  });
  const never = createRouteTracker(probe('unknown', 'loopback'));
  never.sample();
  assert.deepEqual(never.path(), {
    route: EXECUTION_ROUTES.UNKNOWN,
    routeChanged: false,
  });
});
void test('generation time is whole positive milliseconds or absent', () => {
  assert.equal(generationMilliseconds(0), undefined);
  assert.equal(generationMilliseconds(-5), undefined);
  assert.equal(generationMilliseconds(Number.NaN), undefined);
  assert.equal(generationMilliseconds(1.5), undefined);
  assert.equal(generationMilliseconds(400_000), 1);
  assert.equal(generationMilliseconds(2_500_000_000), 2500);
});
void test('seller completion records the route and the engine generation time', async () => {
  const source = await freeSellerFixture();
  const telemetry = localTelemetry();
  const service = createSellerFreeExecution({
    ...source.options,
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
  });
  source.setRun(async () => {
    const result = streamResult();
    return {
      ...result,
      usage: { ...result.usage, outputDurationNs: 500_000_000 },
    };
  });
  const request = await source.request();
  const response = await service.respond(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
    probe('iroh-relay', 'iroh-direct'),
  );
  assert.ok(response.result);
  const completed = terminal(telemetry.events);
  assert.equal(completed.type, TELEMETRY_EVENTS.COMPLETED);
  assert.deepEqual(completed.path, {
    route: EXECUTION_ROUTES.DIRECT,
    routeChanged: true,
  });
  if (completed.type === TELEMETRY_EVENTS.COMPLETED)
    assert.equal(completed.generationMs, 500);
  for (const event of telemetry.events)
    assert.deepEqual(toTelemetryRecord(event), event);
});
void test('seller without a probe or engine timing emits neither field', async () => {
  const source = await freeSellerFixture();
  const telemetry = localTelemetry();
  const service = createSellerFreeExecution({
    ...source.options,
    telemetry: { ...telemetry, engineKind: ENGINE_KINDS.OLLAMA },
  });
  source.setRun(async () => streamResult());
  const request = await source.request();
  await service.respond(
    request,
    request.quote.offer.buyerNodeId,
    freeSellerSignal(),
  );
  const completed = terminal(telemetry.events);
  assert.equal(Object.hasOwn(completed, 'path'), false);
  assert.equal(Object.hasOwn(completed, 'generationMs'), false);
});
void test('seller failure after admission records the route', async () => {
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
    probe('iroh-relay'),
  );
  const failed = terminal(telemetry.events);
  assert.equal(failed.type, TELEMETRY_EVENTS.FAILED);
  assert.deepEqual(failed.path, {
    route: EXECUTION_ROUTES.RELAY,
    routeChanged: false,
  });
  assert.deepEqual(toTelemetryRecord(failed), failed);
});
function completedEvent() {
  return telemetryEvents().find(
    (item): item is Extract<TelemetryEvent, { type: 'completed' }> =>
      item.type === TELEMETRY_EVENTS.COMPLETED,
  )!;
}
void test('telemetry records reject an invalid route or generation time', () => {
  const base = completedEvent();
  for (const invalid of [
    { ...base, path: { route: 'loopback', routeChanged: false } },
    { ...base, path: { route: 'iroh-direct', routeChanged: 'no' } },
    { ...base, path: { route: 'iroh-direct' } },
    { ...base, generationMs: 0 },
    { ...base, generationMs: 1.5 },
  ])
    assert.throws(() => toTelemetryRecord(invalid as TelemetryEvent));
});
void test('OTel records output rate from generation time and executions by route', async () => {
  const fixture = metricExporter();
  const sink = createOtelTelemetrySink(fixture);
  const base = completedEvent();
  sink.emit({
    ...base,
    path: { route: EXECUTION_ROUTES.RELAY, routeChanged: true },
    generationMs: base.usage.outputTokens * 100,
  });
  sink.emit(base);
  await sink.flush();
  const rate = points(fixture.batches, 'gyblos.output_tokens_per_second');
  assert.equal(rate.length, 1);
  const histogram = rate[0]?.value as { count: number; sum: number };
  assert.equal(histogram.count, 1);
  assert.equal(histogram.sum, 10);
  const routes = points(fixture.batches, 'gyblos.routes');
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.value, 1);
  assert.deepEqual(routes[0]?.attributes, {
    ...routes[0]?.attributes,
    route: EXECUTION_ROUTES.RELAY,
    route_changed: true,
    outcome: 'completed',
  });
  await sink.close();
});
