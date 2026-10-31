// Actual paid product startup is accepted only over isolated native loopback and simulated chain services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { main } from '../support/paid-acceptance-cli';
import { PAID_ACCEPTANCE_CASES } from '../support/paid-acceptance-constants';
import {
  parsePaidReport,
  runPaidAcceptance,
} from '../support/paid-acceptance-run';

void test('paid acceptance refuses operational overrides before running', async () => {
  let calls = 0;
  const output: string[] = [];
  assert.equal(
    await main(['--rpc', 'https://example.invalid'], {
      write: (value) => output.push(value),
      run: async () => {
        calls++;
        throw new Error('private');
      },
    }),
    1,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    output.map((value) => JSON.parse(value)),
    [{ ok: false, code: 'ACCEPTANCE_INVALID_OPTIONS' }],
  );
});
void test('paid acceptance refuses cancellation before allocating a home', async () => {
  await assert.rejects(runPaidAcceptance({ signal: AbortSignal.abort() }), {
    code: 'ACCEPTANCE_CANCELLED',
  });
});
void test('paid acceptance rejects incomplete and fabricated evidence', () => {
  assert.throws(() => parsePaidReport('{}'), { code: 'ACCEPTANCE_FAILED' });
});
void test(
  'native paid startup reaches verified settlement and preserves uncertainty across restart',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const report = await runPaidAcceptance();
    assert.equal(report.ok, true);
    assert.equal(report.nativeIroh, true);
    assert.equal(report.simulatedChain, true);
    assert.equal(report.realPayments, false);
    assert.deepEqual(report.cases, Object.values(PAID_ACCEPTANCE_CASES));
    assert.ok(report.answers >= 4);
    assert.ok(report.attempts >= report.answers);
    assert.ok(report.deposits >= report.answers);
    assert.ok(report.settlements >= report.answers);
    assert.ok(report.restarts >= 2);
    assert.ok(report.blocked >= 2);
    assert.equal(report.externalCalls, 0);
  },
);

void test('paid acceptance rejects arithmetically inconsistent evidence', () => {
  const report = {
    ok: true,
    nativeIroh: true,
    simulatedChain: true,
    realPayments: false,
    cases: Object.values(PAID_ACCEPTANCE_CASES),
    answers: 10,
    attempts: 4,
    deposits: 4,
    settlements: 4,
    restarts: 2,
    blocked: 2,
    externalCalls: 0,
    registryReads: 1,
    forbiddenRpcMethods: 0,
  };
  assert.throws(() => parsePaidReport(JSON.stringify(report)), {
    code: 'ACCEPTANCE_FAILED',
  });
});
void test('paid acceptance CLI never reflects private failures', async () => {
  const output: string[] = [];
  assert.equal(
    await main([], {
      write: (value) => output.push(value),
      run: async () => {
        throw new Error('synthetic-private-token');
      },
    }),
    1,
  );
  assert.deepEqual(
    output.map((value) => JSON.parse(value)),
    [{ ok: false, code: 'ACCEPTANCE_FAILED' }],
  );
});
void test('paid acceptance cancels its isolated child without changing parent fetch', async () => {
  const controller = new AbortController();
  const previous = globalThis.fetch;
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(runPaidAcceptance({ signal: controller.signal }), {
      code: 'ACCEPTANCE_CANCELLED',
    });
    assert.equal(globalThis.fetch, previous);
  } finally {
    clearTimeout(timer);
  }
});
