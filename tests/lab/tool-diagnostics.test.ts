import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCEPTANCE_CODES } from '@gyblos/lab-harness/acceptance/constants';
import { AcceptanceError } from '@gyblos/lab-harness/acceptance/errors';
import { TOOL_ACCEPTANCE_CASES } from '@gyblos/lab-harness/acceptance/tools-constants';
import { runToolCase } from '@gyblos/lab-harness/acceptance/tools-diagnostics';
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
          phase('verify');
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
        phase('verify');
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
    scenario,
    code: ACCEPTANCE_CODES.FAILED,
    exitCode: null,
    signal: 'SIGKILL',
    stdoutBytes: Buffer.byteLength(output),
    stderrBytes: 42,
    timedOut: true,
    cancelled: false,
  });
  assert.equal(error.diagnostic.phase, 'verify');
  assert.equal(error.diagnostic.level, 'error');
  assert.equal(error.diagnostic.outcome, 'timeout');
  assert.equal(error.diagnostic.signal, 'SIGKILL');
  assert.ok(!JSON.stringify(error.diagnostic).includes('SECRET-CANARY'));
});
