// Observational helper and local event-schema regressions; synthetic values only, no I/O.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionTelemetry, telemetrySizes, toTelemetryRecord } from '@gyblos/core/telemetry';
import { P2P_ROLES, CONTROL_METERING_MODES } from '@gyblos/protocol/constants';
import { TELEMETRY_EVENTS } from '@gyblos/protocol/telemetry';
import { telemetryEvents } from './support/receipt-fixture';
import { localTelemetry } from './support/local-telemetry';
void test('local buyer events admit unknown remote engine and retain metering origin',()=>{
  const event={...telemetryEvents()[0]!,role:P2P_ROLES.BUYER,engineKind:null,meteringMode:CONTROL_METERING_MODES.DECLARED};
  assert.deepEqual(toTelemetryRecord(event),event);
  assert.throws(()=>toTelemetryRecord({...event,role:P2P_ROLES.SELLER}));
});
void test('execution telemetry computes UTF-8 sizes without storing input or output',()=>{
  assert.deepEqual(telemetrySizes('é','🙂'),{inputBytes:2,inputChars:1,outputBytes:4,outputChars:2});
});
void test('execution observer isolates throwing sinks and emits terminal events only once',()=>{
  const captured=localTelemetry();const fixture=telemetryEvents()[0]!;
  const observer=createExecutionTelemetry({sink:captured.sink,now:captured.now,context:{...fixture,requestId:'33'.repeat(16),sellerNodeId:'11'.repeat(32),meteringMode:CONTROL_METERING_MODES.RECOUNTED}});
  observer.received();observer.firstToken();observer.firstToken();observer.refused('seller_busy');observer.failed('FREE_EXECUTION_INTERNAL_ERROR');observer.firstToken();
  assert.deepEqual(captured.events.map(event=>event.type),[TELEMETRY_EVENTS.REQUEST_RECEIVED,TELEMETRY_EVENTS.FIRST_TOKEN,TELEMETRY_EVENTS.REFUSED]);
});
