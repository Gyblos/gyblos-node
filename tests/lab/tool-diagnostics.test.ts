// Pins safe tool-worker phase reporting and parent observations with injected synthetic failures.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { ACCEPTANCE_CODES } from '@gyblos/lab-harness/acceptance/constants';
import { AcceptanceError } from '@gyblos/lab-harness/acceptance/errors';
import {
  TOOL_ACCEPTANCE_CASES,
  TOOL_DIAGNOSTICS,
} from '@gyblos/lab-harness/acceptance/tools-constants';
import {
  runToolCase,
  toolDiagnostics,
} from '@gyblos/lab-harness/acceptance/tools-diagnostics';
import type { DiagnosticRecord } from '@gyblos/runtime/diagnostics';

void test('tool worker preserves case and last phase for a synthetic failure', async () => {
  const records: DiagnosticRecord[] = [];
  const primary = new AcceptanceError(ACCEPTANCE_CODES.FAILED);
  await assert.rejects(
    runToolCase(
      TOOL_ACCEPTANCE_CASES.OPENAI_JSON,
      new AbortController().signal,
      {
        sink: (record) => records.push(record),
        run: async (_scenario, _signal, phase) => {
          phase(TOOL_DIAGNOSTICS.phases.VERIFY);
          throw primary;
        },
      },
    ),
    (error) => error === primary,
  );
  assert.ok(
    records.some(
      (record) =>
        record.phase === 'verify' &&
        record.code === ACCEPTANCE_CODES.FAILED &&
        record.scenario === TOOL_ACCEPTANCE_CASES.OPENAI_JSON,
    ),
  );
});

void test('parent timeout retains the latest complete phase frame without a final worker report', async () => {
  const { childFailure } = await import('@gyblos/lab-harness/acceptance/tools');
  const records: DiagnosticRecord[] = [];
  const scenario = TOOL_ACCEPTANCE_CASES.OPENAI_JSON;
  await assert.rejects(
    runToolCase(scenario, new AbortController().signal, {
      sink: (record) => records.push(record),
      run: async (_scenario, _signal, phase) => {
        phase(TOOL_DIAGNOSTICS.phases.VERIFY);
        throw new Error('SECRET-CANARY');
      },
    }),
  );
  const output =
    records
      .filter((record) => record.outcome === 'success')
      .map((diagnostic) => JSON.stringify({ diagnostic }))
      .join('\n') + '\n';
  const error = childFailure({
    output,
    observation: { at: new Date().toISOString(), durationMs: 1 },
    scenario,
    code: ACCEPTANCE_CODES.FAILED,
    exitCode: null,
    signal: 'SIGKILL',
    stdoutBytes: Buffer.byteLength(output),
    stderrBytes: 42,
    timedOut: true,
    cancelled: false,
  });
  assert.ok(error.diagnostic);
  assert.equal(error.diagnostic.phase, 'verify');
  assert.equal(error.diagnostic.level, 'error');
  assert.equal(error.diagnostic.outcome, 'timeout');
  assert.equal(error.diagnostic.signal, 'SIGKILL');
  assert.ok(!JSON.stringify(error.diagnostic).includes('SECRET-CANARY'));
});

void test('hostile error code accessor cannot replace a tool failure or become diagnostic content', async () => {
  const primary = new AcceptanceError(ACCEPTANCE_CODES.FAILED);
  let accessed = false;
  Object.defineProperty(primary, 'code', {
    get() {
      accessed = true;
      throw new Error('SECRET-CANARY');
    },
  });
  const records: DiagnosticRecord[] = [];
  await assert.rejects(
    runToolCase(
      TOOL_ACCEPTANCE_CASES.OPENAI_JSON,
      new AbortController().signal,
      {
        sink: (record) => records.push(record),
        run: async () => {
          throw primary;
        },
      },
    ),
    (error) => error === primary,
  );
  assert.equal(accessed, false);
  assert.equal(records.at(-1)?.code, ACCEPTANCE_CODES.FAILED);
  assert.ok(!JSON.stringify(records).includes('SECRET-CANARY'));
});

void test('parent child-failure metadata cannot replace the canonical failure when entropy is unavailable', async () => {
  const { childFailure } = await import('@gyblos/lab-harness/acceptance/tools');
  const { TOOL_ACCEPTANCE_CASES } =
    await import('@gyblos/lab-harness/acceptance/tools-constants');
  const { ACCEPTANCE_CODES } =
    await import('@gyblos/lab-harness/acceptance/constants');
  const original = crypto.randomUUID;
  try {
    crypto.randomUUID = () => {
      throw new Error('synthetic entropy failure');
    };
    syncBuiltinESMExports();
    const failure = childFailure({
      output: '',
      observation: { at: new Date().toISOString(), durationMs: 1 },
      scenario: TOOL_ACCEPTANCE_CASES.OPENAI_JSON,
      code: ACCEPTANCE_CODES.FAILED,
      exitCode: 1,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
      cancelled: false,
    });
    assert.equal(failure.code, ACCEPTANCE_CODES.FAILED);
  } finally {
    crypto.randomUUID = original;
    syncBuiltinESMExports();
  }
});

for (const hasFrame of [false, true]) {
  void test(`terminal child metadata uses parent observation ${hasFrame ? 'with previous frame' : 'without frames'}`, async () => {
    const { childFailure } =
      await import('@gyblos/lab-harness/acceptance/tools');
    const scenario = TOOL_ACCEPTANCE_CASES.OPENAI_JSON;
    const observation = { at: '2026-11-16T21:00:00.000Z', durationMs: 1234 };
    let frame: DiagnosticRecord | undefined;
    toolDiagnostics((record) => {
      frame = record;
    })
      .start()
      .report({
        phase: TOOL_DIAGNOSTICS.phases.VERIFY,
        scenario,
        code: TOOL_DIAGNOSTICS.codes.PROGRESS,
      });
    assert.ok(frame);
    const prior = { ...frame, at: '2000-01-01T00:00:00.000Z', durationMs: 7 };
    const output = hasFrame ? JSON.stringify({ diagnostic: prior }) + '\n' : '';
    const error = childFailure({
      output,
      scenario,
      observation,
      code: ACCEPTANCE_CODES.FAILED,
      exitCode: null,
      signal: 'SIGKILL',
      stdoutBytes: Buffer.byteLength(output),
      stderrBytes: 0,
      timedOut: true,
      cancelled: false,
    });
    assert.equal(error.diagnostic?.durationMs, observation.durationMs);
    assert.equal(error.diagnostic?.at, observation.at);
    assert.equal(
      error.diagnostic?.phase,
      hasFrame
        ? TOOL_DIAGNOSTICS.phases.VERIFY
        : TOOL_DIAGNOSTICS.phases.STARTUP,
    );
  });
}
