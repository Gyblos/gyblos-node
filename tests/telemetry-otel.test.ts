// Exercises aggregate-only telemetry with the real OTel SDK and synthetic events; no node wiring.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExportResultCode } from '@opentelemetry/core';
import { ENGINE_KINDS, FREE_EXECUTION_CODES, P2P_ROLES } from '@gyblos/protocol/constants';
import { TELEMETRY_EVENTS, type TelemetryEvent } from '@gyblos/protocol/telemetry';
import { createOtelTelemetrySink } from '@gyblos/telemetry-otel';
import { metricExporter, points } from './support/otel-fixture';
import { telemetryEvents } from './support/receipt-fixture';

function event<T extends TelemetryEvent['type']>(type: T) {
  return telemetryEvents().find((item): item is Extract<TelemetryEvent, {type: T}> => item.type === type)!;
}
void test('OTel aggregates terminal events once without recounting receipts or charges', async () => {
  const fixture = metricExporter();
  const sink = createOtelTelemetrySink(fixture);
  for (const item of telemetryEvents()) sink.emit(item);
  await sink.flush();
  for (const name of ['requests', 'completed', 'failed', 'unserved'])
    assert.equal(points(fixture.batches, `gyblos.${name}`)[0]?.value, 1);
  assert.equal(points(fixture.batches, 'gyblos.input_tokens')[0]?.value, 7);
  assert.equal(points(fixture.batches, 'gyblos.output_tokens')[0]?.value, 5);
  assert.equal(points(fixture.batches, 'gyblos.reasoning_tokens').length, 0);
  assert.equal(points(fixture.batches, 'gyblos.duration').length, 2);
  assert.equal(points(fixture.batches, 'gyblos.first_token').length, 1);
  assert.equal(points(fixture.batches, 'gyblos.refused').reduce((sum, point) => sum + Number(point.value), 0), 2);
  assert.deepEqual(await sink.close(), {emitted: 9, dropped: 0, failed: false});
});
void test('OTel exports only closed attributes and an empty resource', async () => {
  const fixture = metricExporter();
  const sink = createOtelTelemetrySink(fixture);
  for (let index = 0; index < 300; index++) {
    sink.emit({...event(TELEMETRY_EVENTS.REQUEST_RECEIVED), requestId: index.toString(16).padStart(32, '0'), buyerNodeId: index.toString(16).padStart(64, '0'), selection: {modelId: `private-model-${index}`, variant:null, quantization:null}, prompt: 'PRIVATE-MARKER'} as TelemetryEvent);
  }
  await sink.flush();
  const output = JSON.stringify(fixture.batches);
  assert.doesNotMatch(output, /PRIVATE-MARKER|private-model|buyerNodeId|sellerNodeId|requestId|signature|traceId|spanId|host.name/);
  assert.deepEqual(fixture.batches[0]?.resource.attributes, {});
  const recorded = points(fixture.batches, 'gyblos.requests');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.value, 300);
  assert.deepEqual(recorded[0]?.attributes, {role: P2P_ROLES.SELLER, engine: ENGINE_KINDS.OLLAMA, streaming: true});
  await sink.close();
});
void test('OTel handles null sellers, reasoning usage and delivered partial output separately', async () => {
  const fixture = metricExporter();
  const sink = createOtelTelemetrySink(fixture);
  sink.emit({...event(TELEMETRY_EVENTS.COMPLETED), usage: {inputTokens:7, outputTokens:5, reasoningTokens:2}});
  sink.emit({...event(TELEMETRY_EVENTS.FAILED), delivered: {outputTokens:3}});
  sink.emit(event(TELEMETRY_EVENTS.UNSERVED));
  await sink.flush();
  assert.equal(points(fixture.batches, 'gyblos.reasoning_tokens')[0]?.value, 2);
  assert.equal(points(fixture.batches, 'gyblos.delivered_output_tokens')[0]?.value, 3);
  assert.deepEqual(points(fixture.batches, 'gyblos.unserved')[0]?.attributes, {role: P2P_ROLES.SELLER, streaming:true});
  await sink.close();
});
void test('OTel malformed measurements and known accessors are dropped without invoking getters', async () => {
  const fixture = metricExporter();
  const sink = createOtelTelemetrySink(fixture);
  let accessed = false;
  const accessor = {...event(TELEMETRY_EVENTS.FIRST_TOKEN)};
  Object.defineProperty(accessor, 'firstTokenMs', { get() { accessed = true; return 1; } });
  const invalid: TelemetryEvent[] = [accessor, {...event(TELEMETRY_EVENTS.FIRST_TOKEN), firstTokenMs: NaN}, {...event(TELEMETRY_EVENTS.COMPLETED), totalMs:-1}, {...event(TELEMETRY_EVENTS.COMPLETED), usage:{inputTokens:Number.MAX_SAFE_INTEGER+1, outputTokens:1, reasoningTokens:null}}];
  for (const item of invalid) assert.doesNotThrow(() => sink.emit(item));
  assert.deepEqual(await sink.close(), {emitted:0, dropped:4, failed:true});
  assert.equal(accessed, false);
  assert.equal(fixture.batches.length, 0);
});
void test('OTel construction, unused flush and close have no timers or exporter calls', async context => {
  const fixture = metricExporter();
  let timers = 0;
  context.mock.method(globalThis, 'setInterval', () => {timers++; throw new Error('unexpected');});
  context.mock.method(globalThis, 'setTimeout', () => {timers++; throw new Error('unexpected');});
  const sink = createOtelTelemetrySink(fixture);
  await sink.flush();
  assert.deepEqual(await sink.close(), {emitted:0,dropped:0,failed:false});
  assert.equal(timers, 0);
  assert.equal(fixture.batches.length, 0);
  assert.equal(fixture.shutdowns(), 0);
});
void test('OTel lifecycle coalesces flush and closes once; post-close emit is ignored', async () => {
  const fixture = metricExporter();
  const sink = createOtelTelemetrySink(fixture);
  sink.emit(event(TELEMETRY_EVENTS.REQUEST_RECEIVED));
  await Promise.all([sink.flush(), sink.flush()]);
  assert.equal(fixture.batches.length, 1);
  const closing = sink.close();
  sink.emit(event(TELEMETRY_EVENTS.REQUEST_RECEIVED));
  assert.deepEqual(await closing, {emitted:1,dropped:1,failed:false});
  assert.deepEqual(await sink.close(), await closing);
  await sink.flush();
  assert.equal(fixture.shutdowns(), 1);
  assert.equal(points(fixture.batches, 'gyblos.requests')[0]?.value, 1);
});
void test('OTel exporter failure and shutdown exceptions never escape sink lifecycle', async () => {
  const fixture = metricExporter();
  fixture.exporter.export = (_metrics, callback) => callback({code:ExportResultCode.FAILED, error:new Error('PRIVATE-MARKER')});
  fixture.exporter.shutdown = async () => { throw new Error('PRIVATE-MARKER'); };
  const sink = createOtelTelemetrySink(fixture);
  sink.emit(event(TELEMETRY_EVENTS.REQUEST_RECEIVED));
  await assert.doesNotReject(sink.flush());
  assert.equal((await sink.close()).failed, true);
});
void test('OTel caps attribute cardinality and preserves counts in SDK overflow', async () => {
  const fixture = metricExporter();
  const sink = createOtelTelemetrySink(fixture);
  let total = 0;
  for (const role of Object.values(P2P_ROLES)) for (const engineKind of Object.values(ENGINE_KINDS)) for (const streaming of [false,true]) for (const code of Object.values(FREE_EXECUTION_CODES)) {
    sink.emit({...event(TELEMETRY_EVENTS.FAILED), role, engineKind, streaming, code});
    total++;
  }
  await sink.flush();
  const recorded = points(fixture.batches, 'gyblos.failed');
  assert.ok(recorded.length <= 128);
  assert.ok(recorded.some(point => point.attributes['otel.metric.overflow'] === true));
  assert.equal(recorded.reduce((sum, point) => sum + Number(point.value), 0), total);
  await sink.close();
});
