// Owns the contract every seller execution follows through runAdmittedExecution, free or paid: the policy
// finishes exactly once with what was delivered (even after a failure, a cancellation or a deadline), the
// slot is always released and finishing never sees the request's signal. A synthetic deposit-style
// policy stands in for payments; tests/policy-free.test.ts owns the free policy.
import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ExecutionOutcome,
  ExecutionPermit,
} from '@gyblos/protocol/execution-policy';

import {
  runAdmittedExecution,
  type AdmittedExecution,
  type ExecutionSession,
} from '../packages/node/src/execution';

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

interface Overrides extends Partial<
  Omit<AdmittedExecution<string, string, string>, 'open'>
> {
  generate?: (signal: AbortSignal, check: () => void) => Promise<string>;
  stop?: () => void;
  measure?: ExecutionSession<string>['measure'];
}

function execution(
  overrides: Overrides,
  fake = depositPolicy(),
): AdmittedExecution<string, string, string> {
  const {
    generate = () => Promise.resolve('hello'),
    stop,
    measure = (generated) =>
      'value' in generated
        ? { inputTokens: 4, outputTokens: 2, completed: true }
        : { inputTokens: 4, outputTokens: 1, completed: false },
    ...rest
  } = overrides;
  return {
    policy: fake.policy,
    permit: { outputTokens: 8, state: 'deposit' },
    now: Date.now,
    signal: new AbortController().signal,
    errors: ERRORS,
    open: (window) => ({
      generate: () => generate(window.signal, window.check),
      ...(stop ? { stop } : {}),
      measure,
    }),
    nothing: NOTHING,
    ...rest,
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

void test('execution contract: an invalid deadline is a policy bug that charges nothing and never starts the engine', async () => {
  const fake = depositPolicy();
  let generated = false;
  const run = await runAdmittedExecution(
    execution(
      {
        permit: { outputTokens: 8, deadline: Number.NaN, state: 'deposit' },
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
    'error' in run.generated && run.generated.error instanceof RangeError,
  );
  assert.deepEqual(
    fake.finished.map((entry) => entry.outcome),
    [NOTHING],
  );
  assert.equal(fake.releases(), 1);
});

void test('execution contract: a throwing stop still ends the generation at the deadline', async () => {
  const fake = depositPolicy();
  let clock = 1_000;
  let windowSignal: AbortSignal | undefined;
  const run = await runAdmittedExecution(
    execution(
      {
        permit: { outputTokens: 8, deadline: 1_020, state: 'deposit' },
        now: () => clock,
        stop: () => {
          throw new Error('stop bug');
        },
        generate: (signal) => {
          windowSignal = signal;
          clock = 1_010;
          return new Promise(() => {});
        },
      },
      fake,
    ),
  ).catch((error: unknown) => ({ thrown: error }));
  assert.ok('generated' in run && 'error' in run.generated);
  assert.equal(windowSignal?.aborted, true);
  assert.equal(fake.finished.length, 1);
  assert.equal(fake.releases(), 1);
});

void test('execution contract: a fast generation clears its deadline timer', async () => {
  const timers = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
      .length;
  const before = timers();
  const fake = depositPolicy();
  const run = await runAdmittedExecution(
    execution(
      {
        permit: {
          outputTokens: 8,
          deadline: Date.now() + 60_000,
          state: 'deposit',
        },
      },
      fake,
    ),
  );
  assert.deepEqual(run.generated, { value: 'hello' });
  assert.equal(timers(), before);
});
