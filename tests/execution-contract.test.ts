// Owns the contract every seller execution follows through runAdmittedExecution, free or paid: the policy
// finishes exactly once with what was delivered (even after a failure, a cancellation or a deadline), the
// slot is always released, finishing never sees the request's signal, and the free policy keeps its caps
// and refunds only a completed recounted sale. A synthetic deposit-style policy stands in for payments.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FREE_EXECUTION_ADMISSION } from '@gyblos/core/constants';
import { FreeExecutionAdmission } from '@gyblos/core/free-admission';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type {
  ExecutionOutcome,
  ExecutionPermit,
} from '@gyblos/protocol/execution-policy';
import { parseFreeExecutionRequest } from '@gyblos/protocol/free-execution';

import {
  runAdmittedExecution,
  type AdmittedExecution,
} from '../packages/node/src/execution';
import { createFreePolicy } from '../packages/node/src/policy-free';

class Timeout extends Error {}
class Cancelled extends Error {}
const ERRORS = {
  timeout: new Timeout('timeout'),
  cancelled: () => new Cancelled('cancelled'),
};
const NOTHING: ExecutionOutcome = {
  inputTokens: 4,
  outputTokens: 0,
  completed: false,
};

// A deposit-style policy: it records every finish (with whether the request was already cancelled)
// and every release, and settles what was delivered.
function depositPolicy(fail?: Error) {
  const finished: { outcome: ExecutionOutcome; aborted: boolean }[] = [];
  let releases = 0;
  let request: AbortController | undefined;
  return {
    finished,
    releases: () => releases,
    watch: (controller: AbortController) => (request = controller),
    policy: {
      finish(_permit: ExecutionPermit<string>, outcome: ExecutionOutcome) {
        finished.push({ outcome, aborted: request?.signal.aborted ?? false });
        if (fail) return Promise.reject(fail);
        return Promise.resolve(`settled ${outcome.outputTokens}`);
      },
      release() {
        releases++;
      },
    },
  };
}

function execution(
  overrides: Partial<AdmittedExecution<string, string, string>>,
  fake = depositPolicy(),
): AdmittedExecution<string, string, string> {
  return {
    policy: fake.policy,
    permit: { outputTokens: 8, state: 'deposit' },
    now: Date.now,
    signal: new AbortController().signal,
    errors: ERRORS,
    generate: () => Promise.resolve('hello'),
    measure: (generated) =>
      'value' in generated
        ? { inputTokens: 4, outputTokens: 2, completed: true }
        : { inputTokens: 4, outputTokens: 1, completed: false },
    nothing: NOTHING,
    ...overrides,
  };
}

void test('execution contract: a completed generation finishes once with its measure and releases once', async () => {
  const fake = depositPolicy();
  const run = await runAdmittedExecution(execution({}, fake));
  assert.deepEqual(run.generated, { value: 'hello' });
  assert.equal(run.settlement, 'settled 2');
  assert.deepEqual(fake.finished, [
    {
      outcome: { inputTokens: 4, outputTokens: 2, completed: true },
      aborted: false,
    },
  ]);
  assert.equal(fake.releases(), 1);
});

void test('execution contract: a failed generation still finishes with what was delivered', async () => {
  const fake = depositPolicy();
  const failure = new Error('engine stopped');
  const run = await runAdmittedExecution(
    execution({ generate: () => Promise.reject(failure) }, fake),
  );
  assert.deepEqual(run.generated, { error: failure });
  assert.deepEqual(
    fake.finished.map((entry) => entry.outcome),
    [{ inputTokens: 4, outputTokens: 1, completed: false }],
  );
  assert.equal(fake.releases(), 1);
});

void test('execution contract: a measuring bug charges nothing but still finishes and releases', async () => {
  const fake = depositPolicy();
  const run = await runAdmittedExecution(
    execution(
      {
        measure: () => {
          throw new Error('meter bug');
        },
      },
      fake,
    ),
  );
  assert.ok('error' in run.generated);
  assert.deepEqual(
    fake.finished.map((entry) => entry.outcome),
    [NOTHING],
  );
  assert.equal(fake.releases(), 1);
});

void test('execution contract: a failing finish still releases and reports its failure', async () => {
  const fake = depositPolicy(new Error('settlement unavailable'));
  await assert.rejects(runAdmittedExecution(execution({}, fake)), {
    message: 'settlement unavailable',
  });
  assert.equal(fake.finished.length, 1);
  assert.equal(fake.releases(), 1);
});

void test('execution contract: a cancelled request finishes after the cancellation, never skipping it', async () => {
  const fake = depositPolicy();
  const controller = new AbortController();
  fake.watch(controller);
  const run = await runAdmittedExecution(
    execution(
      {
        signal: controller.signal,
        generate: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
            controller.abort(new Cancelled('cancelled'));
          }),
      },
      fake,
    ),
  );
  assert.ok(
    'error' in run.generated && run.generated.error instanceof Cancelled,
  );
  assert.deepEqual(fake.finished, [
    {
      outcome: { inputTokens: 4, outputTokens: 1, completed: false },
      aborted: true,
    },
  ]);
  assert.equal(fake.releases(), 1);
});

void test('execution contract: an already cancelled request never reaches the engine but finishes', async () => {
  const fake = depositPolicy();
  const controller = new AbortController();
  controller.abort();
  let generated = false;
  const run = await runAdmittedExecution(
    execution(
      {
        signal: controller.signal,
        generate: () => {
          generated = true;
          return Promise.resolve('late');
        },
      },
      fake,
    ),
  );
  assert.equal(generated, false);
  assert.ok(
    'error' in run.generated && run.generated.error instanceof Cancelled,
  );
  assert.equal(fake.finished.length, 1);
  assert.equal(fake.releases(), 1);
});

void test('execution contract: a permit deadline stops a slow engine, stops publication and still finishes', async () => {
  const fake = depositPolicy();
  let clock = 1_000;
  let stopped = false;
  let windowSignal: AbortSignal | undefined;
  const run = await runAdmittedExecution(
    execution(
      {
        permit: { outputTokens: 8, deadline: 1_020, state: 'deposit' },
        now: () => clock,
        stop: () => {
          stopped = true;
        },
        generate: (signal) => {
          windowSignal = signal;
          clock = 1_010;
          // Never resolves: only the deadline ends it.
          return new Promise(() => {});
        },
      },
      fake,
    ),
  );
  assert.ok('error' in run.generated && run.generated.error instanceof Timeout);
  assert.equal(stopped, true);
  assert.equal(windowSignal?.aborted, true);
  assert.equal(fake.finished.length, 1);
  assert.equal(fake.releases(), 1);
});

void test('execution contract: a deadline already passed refuses to start the engine', async () => {
  const fake = depositPolicy();
  let generated = false;
  const run = await runAdmittedExecution(
    execution(
      {
        permit: { outputTokens: 8, deadline: 1_000, state: 'deposit' },
        now: () => 1_000,
        generate: () => {
          generated = true;
          return Promise.resolve('late');
        },
      },
      fake,
    ),
  );
  assert.equal(generated, false);
  assert.ok('error' in run.generated && run.generated.error instanceof Timeout);
  assert.equal(fake.finished.length, 1);
});

async function freeFixture() {
  const vector: { request: unknown } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/free-execution-v3.json'),
      ),
      'utf8',
    ),
  );
  const source = parseFreeExecutionRequest(vector.request);
  const now = FREE_EXECUTION_ADMISSION.utcDayMs - 10;
  const request = (id: number) => ({
    ...source,
    requestId: id.toString(16).padStart(32, '0'),
    input: { ...source.input, maxTokens: 10 },
    quote: {
      ...source.quote,
      offer: {
        ...source.quote.offer,
        requestId: id.toString(16).padStart(32, '0'),
        issuedAt: now,
        expiresAt: now + 1000,
      },
    },
  });
  return { now, request };
}

void test('free policy: the permit is the request ceiling, and only a completed refunding sale returns tokens', async () => {
  const { now, request } = await freeFixture();
  const admission = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 28, perBuyerCap: 28 },
    now - 1,
  );
  const policy = createFreePolicy(admission, { refunds: true });
  const context = { inputTokens: 4, now };
  const first = await policy.admit(request(1), context);
  assert.equal(first.outputTokens, 10);
  assert.equal(first.deadline, undefined);
  await assert.rejects(policy.admit(request(2), context), {
    code: FREE_EXECUTION_CODES.BUSY,
  });
  // Completed with 4 + 2 of the 14 reserved: 8 tokens return, so a second 14 still fits in 28.
  await policy.finish(first, {
    inputTokens: 4,
    outputTokens: 2,
    completed: true,
  });
  policy.release(first);
  policy.release(first);
  const second = await policy.admit(request(3), context);
  // A failed sale keeps its whole reservation: 6 + 14 + 14 > 28.
  await policy.finish(second, {
    inputTokens: 4,
    outputTokens: 2,
    completed: false,
  });
  policy.release(second);
  await assert.rejects(policy.admit(request(4), context), {
    code: FREE_EXECUTION_CODES.DAILY_CAP,
  });
});

void test('free policy: a declared meter never refunds, and release alone frees the slot without refund', async () => {
  const { now, request } = await freeFixture();
  const admission = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 28, perBuyerCap: 28 },
    now - 1,
  );
  const policy = createFreePolicy(admission, { refunds: false });
  const context = { inputTokens: 4, now };
  const first = await policy.admit(request(1), context);
  await policy.finish(first, {
    inputTokens: 4,
    outputTokens: 2,
    completed: true,
  });
  const second = await policy.admit(request(2), context);
  policy.release(second);
  // 14 + 14 kept: nothing fits.
  await assert.rejects(policy.admit(request(3), context), {
    code: FREE_EXECUTION_CODES.DAILY_CAP,
  });
});
