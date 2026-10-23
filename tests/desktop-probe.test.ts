// Verifies the desktop IPC summary boundary with synthetic, unfunded inputs.
// Does not import Electron, bind sockets or initialize any product service.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  armSmokeWatchdog,
  DESKTOP,
  parseProbeResult,
  PROBE_STATUS,
  reportProbeResult,
  type ResultPort,
} from '@gyblos/desktop/probe-model';

const passed = () => ({
  status: PROBE_STATUS.PASSED,
  cycles: DESKTOP.CYCLES,
  roundTrips: DESKTOP.CYCLES,
  closed: true,
});
void test('desktop probe accepts only completed two-cycle summaries', () => {
  assert.deepEqual(parseProbeResult(passed()), passed());
});
void test('desktop probe rejects unknown result states and incomplete cleanup', () => {
  for (const input of [
    { ...passed(), status: 'unknown' },
    { ...passed(), closed: false },
  ]) {
    assert.equal(parseProbeResult(input).status, PROBE_STATUS.FAILED);
  }
});
void test('desktop probe refuses partial, nonfinite and string cycle counts', () => {
  for (const cycles of [0, 1, NaN, Infinity, '2'])
    assert.equal(
      parseProbeResult({ ...passed(), cycles }).status,
      PROBE_STATUS.FAILED,
    );
  assert.equal(
    parseProbeResult({ ...passed(), roundTrips: 1 }).status,
    PROBE_STATUS.FAILED,
  );
});
void test('desktop probe drops extra fields rather than forwarding native data', () => {
  const result = parseProbeResult({
    ...passed(),
    diagnostic: 'synthetic private SDK detail',
  });
  assert.equal(result.status, PROBE_STATUS.FAILED);
  assert.equal(JSON.stringify(result).includes('synthetic private'), false);
  assert.deepEqual(Object.keys(result).sort(), [
    'closed',
    'cycles',
    'roundTrips',
    'status',
  ]);
});
void test('desktop probe rejects malformed external values without throwing', () => {
  for (const input of [
    null,
    [],
    true,
    2,
    'synthetic',
    {},
    { status: PROBE_STATUS.PASSED },
  ])
    assert.equal(parseProbeResult(input).status, PROBE_STATUS.FAILED);
});

void test('desktop smoke fails when renderer never invokes its bridge', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let failures = 0;
  armSmokeWatchdog(() => {
    failures += 1;
  });
  context.mock.timers.tick(DESKTOP.STARTUP_DEADLINE_MS);
  assert.equal(failures, 1);
});
void test('desktop smoke completion cancels its startup watchdog', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let failures = 0;
  const cancel = armSmokeWatchdog(() => {
    failures += 1;
  });
  cancel();
  context.mock.timers.tick(DESKTOP.STARTUP_DEADLINE_MS);
  assert.equal(failures, 0);
});

void test('desktop worker waits for summary receipt before a successful exit', () => {
  let receive: ((message: { data: unknown }) => void) | undefined;
  let exitCode: number | undefined;
  const messages: unknown[] = [];
  const port: ResultPort = {
    once(_event, listener) {
      receive = listener;
    },
    postMessage(message) {
      messages.push(message);
    },
  };
  reportProbeResult(port, passed(), (code) => {
    exitCode = code;
  });
  assert.deepEqual(messages, [passed()]);
  assert.equal(exitCode, undefined);
  assert.ok(receive);
  receive({ data: DESKTOP.FINISH_ACK });
  assert.equal(exitCode, 0);
});
void test('desktop worker preserves failure exit after receipt', () => {
  let receive: ((message: { data: unknown }) => void) | undefined;
  let exitCode: number | undefined;
  const port: ResultPort = {
    once(_event, listener) {
      receive = listener;
    },
    postMessage() {},
  };
  reportProbeResult(port, parseProbeResult(null), (code) => {
    exitCode = code;
  });
  assert.ok(receive);
  receive({ data: 'synthetic-invalid-ack' });
  assert.equal(exitCode, undefined);
  receive({ data: DESKTOP.FINISH_ACK });
  assert.equal(exitCode, 1);
});

void test('desktop worker never exits successfully for an invalid acknowledgement', () => {
  let receive: ((message: { data: unknown }) => void) | undefined;
  let exited = false;
  const port: ResultPort = {
    once(_event, listener) {
      receive = listener;
    },
    postMessage() {},
  };
  reportProbeResult(port, passed(), () => {
    exited = true;
  });
  assert.ok(receive);
  receive({ data: 'synthetic-invalid-ack' });
  assert.equal(exited, false);
});
