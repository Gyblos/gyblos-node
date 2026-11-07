// Actual paid product startup is accepted only over isolated native loopback and simulated chain services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER, PAID_BUYER, PAID_VERDICTS } from '@gyblos/buyer/constants';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  MODEL_IDS,
} from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import {
  assertPaidJsonAnswer,
  assertPaidStreamAnswer,
} from '../support/paid-acceptance-answers';
import { main } from '../support/paid-acceptance-cli';
import {
  PAID_ACCEPTANCE,
  PAID_ACCEPTANCE_CASES,
} from '../support/paid-acceptance-constants';
import { finishPaidAcceptance } from '../support/paid-acceptance-finalize';
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
    assert.ok(report.cases.includes(PAID_ACCEPTANCE_CASES.CLI_ANSWER));
    assert.ok(report.cases.includes(PAID_ACCEPTANCE_CASES.CLI_INTERRUPTED));
    assert.deepEqual(report.cases, Object.values(PAID_ACCEPTANCE_CASES));
    assert.ok(report.answers >= 4);
    assert.ok(report.attempts >= report.answers);
    assert.ok(report.deposits >= report.answers);
    assert.ok(report.settlements >= report.answers);
    assert.ok(report.restarts >= 2);
    assert.ok(report.blocked >= 2);
    assert.equal(report.externalCalls, 0);
    assert.equal(Reflect.get(report, 'freeAnswers'), 3);
    assert.equal(Reflect.get(report, 'freeAttempts'), 4);
    assert.equal(Reflect.get(report, 'freePaymentPreparations'), 0);
    assert.equal(Reflect.get(report, 'freeTokenizerLoads'), 0);
    assert.equal(Reflect.get(report, 'confirmedReceipts'), 3);
    assert.ok(Reflect.get(report, 'telemetryEvents') >= 6);
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

void test('paid delivery assertions reject verdict metadata without the answer', () => {
  const response = {
    id: 'chatcmpl-synthetic',
    object: FREE_BUYER.completionObject,
    created: 0,
    model: MODEL_IDS.QWEN3_0_6B,
    choices: [
      {
        index: 0,
        message: { role: FREE_CHAT_ROLES.ASSISTANT, content: '' },
        finish_reason: ENGINE_DONE_REASONS.STOP,
      },
    ],
    usage: {
      prompt_tokens: PAID_ACCEPTANCE.inputTokens,
      completion_tokens: [...PAID_ACCEPTANCE.text].length,
      total_tokens:
        PAID_ACCEPTANCE.inputTokens + [...PAID_ACCEPTANCE.text].length,
    },
    [PAID_BUYER.paymentField]: {
      verdict: PAID_VERDICTS.UNVERIFIED,
      maxAtomic: PAID_ACCEPTANCE.maxAtomic,
      expectedAtomic: '48',
      chargedAtomic: '48',
      sellerAtomic: '46',
      feeAtomic: '1',
      refundedAtomic: '952',
      recorded: true,
    },
  };
  assert.throws(() =>
    assertPaidJsonAnswer(JSON.stringify(response), PAID_VERDICTS.UNVERIFIED),
  );
});
void test('paid stream framing rejects an ordinary JSON completion', () => {
  assert.throws(() =>
    assertPaidStreamAnswer(
      JSON.stringify({
        text: 'synthetic paid answer',
        verdict: PAID_VERDICTS.SETTLED,
      }),
      'application/json',
    ),
  );
});
void test('paid acceptance teardown cannot hide swallowed forbidden I/O', async () => {
  let denied = 0;
  await assert.rejects(
    finishPaidAcceptance(
      async () => {
        const refusedFetch = async () => {
          denied++;
          throw new Error('Synthetic forbidden cleanup I/O');
        };
        await refusedFetch().catch(() => {});
      },
      () => {
        assert.equal(denied, 0);
        return true;
      },
    ),
    { code: 'ERR_ASSERTION' },
  );
});

void test('paid acceptance rejects paid-only evidence without the unified free journey', () => {
  assert.throws(
    () =>
      parsePaidReport(
        JSON.stringify({
          ok: true,
          nativeIroh: true,
          simulatedChain: true,
          realPayments: false,
          cases: Object.values(PAID_ACCEPTANCE_CASES),
          answers: 4,
          attempts: 4,
          deposits: 4,
          settlements: 4,
          restarts: 2,
          blocked: 2,
          externalCalls: 0,
          registryReads: 1,
          forbiddenRpcMethods: 0,
        }),
      ),
    { code: 'ACCEPTANCE_FAILED' },
  );
});
