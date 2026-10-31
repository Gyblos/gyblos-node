// Isolated native product-startup scenario; synthetic funds only and metadata-only public output.
import assert from 'node:assert/strict';
import { readdir, realpath } from 'node:fs/promises';
import { basename } from 'node:path';

import { homeLayout } from '@gyblos/config';
import {
  ACCEPTANCE,
  ACCEPTANCE_CODES,
} from '@gyblos/lab-harness/acceptance/constants';
import { AcceptanceError } from '@gyblos/lab-harness/acceptance/errors';
import { assertAcceptanceTempBase } from '@gyblos/lab-harness/acceptance/workspace';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

import {
  PAID_ACCEPTANCE,
  PAID_ACCEPTANCE_CASES,
  type PaidAcceptanceReport,
} from './paid-acceptance-constants';
import { paidAcceptanceHost, paidWait } from './paid-acceptance-host';
import { paidAnswer, paidBody, paidHttp } from './paid-acceptance-http';
import {
  paidPreSend,
  paidPrivateRecords,
  paidRecovery,
  paidWrongShares,
} from './paid-acceptance-phases';

async function uncertain(
  run: Awaited<ReturnType<typeof paidAcceptanceHost>>,
  signal: AbortSignal,
) {
  const before = [
    run.engine.attempts(),
    run.payments.authorizations(),
    run.payments.deposits(),
  ];
  const response = await paidHttp(run, signal);
  await paidBody(response);
  assert.notEqual(response.statusCode, 200);
  assert.deepEqual(
    [
      run.engine.attempts(),
      run.payments.authorizations(),
      run.payments.deposits(),
    ],
    before,
  );
}
export async function paidScenario(
  signal: AbortSignal,
): Promise<PaidAcceptanceReport> {
  assert.ok(basename(process.cwd()).startsWith(ACCEPTANCE.temporaryPrefix));
  assert.equal(process.env.GYBLOS_HOME, process.cwd());
  assert.equal(process.env.GYBLOS_LAB_HOME, process.cwd());
  assertAcceptanceTempBase(await realpath(process.cwd()));
  for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER])
    assert.equal(
      (await readdir(homeLayout(process.env).roles[role])).length,
      0,
    );
  const run = await paidAcceptanceHost(signal);
  const cases: PaidAcceptanceReport['cases'] = [PAID_ACCEPTANCE_CASES.STARTUP];
  let restarts = 0;
  let answers = 0;
  let blocked = 0;
  try {
    await paidPreSend(run, signal);
    cases.push(PAID_ACCEPTANCE_CASES.PRESEND);
    await paidAnswer(run, signal);
    answers++;
    cases.push(PAID_ACCEPTANCE_CASES.COMPLETE);
    await paidAnswer(run, signal, true);
    answers++;
    cases.push(PAID_ACCEPTANCE_CASES.STREAM);
    const beforeRestart = run.payments.settlements();
    await run.restart(true);
    restarts++;
    assert.equal(run.payments.settlements(), beforeRestart);
    await paidAnswer(run, signal);
    answers++;
    cases.push(PAID_ACCEPTANCE_CASES.RESTART);
    await paidWrongShares(run, signal);
    answers++;
    cases.push(PAID_ACCEPTANCE_CASES.SHARES);
    run.payments.unavailable(true);
    const unverified = await paidHttp(run, signal);
    const unverifiedBody = await paidBody(unverified);
    assert.equal(unverified.statusCode, 200);
    answers++;
    assert.ok(unverifiedBody.includes('unverified'));
    await uncertain(run, signal);
    blocked++;
    cases.push(PAID_ACCEPTANCE_CASES.PENDING);
    await run.restart(false);
    restarts++;
    await uncertain(run, signal);
    blocked++;
    cases.push(PAID_ACCEPTANCE_CASES.PERSISTED);
    run.payments.unavailable(false);
    await run.payments.confirmLast();
    await paidAnswer(run, signal);
    answers++;
    cases.push(PAID_ACCEPTANCE_CASES.CONFIRMED);
    await paidRecovery(run, signal);
    answers++;
    restarts++;
    cases.push(PAID_ACCEPTANCE_CASES.RECOVERY);
    const beforeFailure = run.engine.attempts();
    run.engine.fail(true);
    const failure = await paidHttp(run, signal);
    await paidBody(failure);
    assert.notEqual(failure.statusCode, 200);
    assert.equal(run.engine.attempts(), beforeFailure + 1);
    cases.push(PAID_ACCEPTANCE_CASES.ENGINE);
    run.engine.fail(false);
    await run.restart(true);
    restarts++;
    run.engine.hold();
    const beforeCancel = run.engine.attempts();
    const response = await paidHttp(run, signal, true);
    response.once('error', () => {});
    await new Promise<void>((resolve, reject) => {
      response.once('data', () => resolve());
      response.once('error', reject);
    });
    response.destroy();
    await paidWait(() => run.engine.attempts() === beforeCancel + 1, signal);
    await paidWait(() => run.engine.cancellations() === 1, signal);
    await paidWait(
      () => run.payments.settlements() === run.payments.deposits(),
      signal,
    );
    await uncertain(run, signal);
    blocked++;
    assert.equal(run.engine.attempts(), beforeCancel + 1);
    cases.push(PAID_ACCEPTANCE_CASES.CANCEL);
    await paidPrivateRecords();
    cases.push(PAID_ACCEPTANCE_CASES.PRIVACY);
    assert.equal(run.external(), 0);
    assert.ok(run.registry.counts().reads > 0);
    assert.equal(run.registry.counts().forbidden, 0);
    assert.ok(run.reads() >= answers);
    assert.equal(run.payments.uniqueChannels(), run.payments.authorizations());
    cases.push(PAID_ACCEPTANCE_CASES.ISOLATION);
    return {
      ok: true,
      nativeIroh: true,
      simulatedChain: true,
      realPayments: false,
      cases,
      answers,
      attempts: run.engine.attempts(),
      deposits: run.payments.deposits(),
      settlements: run.payments.settlements(),
      restarts,
      blocked,
      externalCalls: run.external(),
      registryReads: run.registry.counts().reads,
      forbiddenRpcMethods: run.registry.counts().forbidden,
    };
  } finally {
    await run.close();
  }
}
async function main() {
  try {
    console.log(
      JSON.stringify(
        await paidScenario(AbortSignal.timeout(PAID_ACCEPTANCE.runMs)),
      ),
    );
    return 0;
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        code:
          error instanceof AcceptanceError
            ? error.code
            : ACCEPTANCE_CODES.FAILED,
      }),
    );
    return 1;
  }
}
if (isMain(import.meta.url)) process.exitCode = await main();
