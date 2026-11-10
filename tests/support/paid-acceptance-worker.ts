// Isolated native product-startup scenario; synthetic funds only and metadata-only public output.
import assert from 'node:assert/strict';
import { readdir, realpath } from 'node:fs/promises';
import { basename } from 'node:path';

import { PAID_BUYER_CODES, PAID_VERDICTS } from '@gyblos/buyer/constants';
import { homeLayout } from '@gyblos/config';
import {
  ACCEPTANCE,
  ACCEPTANCE_CODES,
} from '@gyblos/lab-harness/acceptance/constants';
import { AcceptanceError } from '@gyblos/lab-harness/acceptance/errors';
import { assertAcceptanceTempBase } from '@gyblos/lab-harness/acceptance/workspace';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { OFFER_PRICING_KINDS, P2P_ROLES } from '@gyblos/protocol/constants';
import { controlObject } from '@gyblos/protocol/control-validation';
import { isMain } from '@gyblos/runtime';

import { assertPaidJsonAnswer } from './paid-acceptance-answers';
import {
  PAID_ACCEPTANCE,
  PAID_ACCEPTANCE_CASES,
  type PaidAcceptanceReport,
} from './paid-acceptance-constants';
import { finishPaidAcceptance } from './paid-acceptance-finalize';
import { paidAcceptanceHost, paidWait } from './paid-acceptance-host';
import { paidAnswer, paidBody, paidHttp } from './paid-acceptance-http';
import {
  paidPreSend,
  paidPrivateRecords,
  paidRecovery,
  paidWrongShares,
} from './paid-acceptance-phases';
import { paidTerminal } from './paid-acceptance-terminal';
import { unifiedFreeJourney } from './unified-acceptance-free';
import { unifiedPrivateEvidence } from './unified-acceptance-metadata';

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
  const value: unknown = JSON.parse(await paidBody(response));
  const body = controlObject(value, ['error']);
  const error = controlObject(body.error, [
    'message',
    'type',
    'param',
    'code',
    BUYER_API.NEVER_SENT_FIELD,
  ]);
  assert.equal(error[BUYER_API.NEVER_SENT_FIELD], true);
  assert.equal(error.code, PAID_BUYER_CODES.UNRESOLVED);
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
  const originalFetch = globalThis.fetch;
  const run = await paidAcceptanceHost(signal, OFFER_PRICING_KINDS.FREE);
  const cases: PaidAcceptanceReport['cases'] = [PAID_ACCEPTANCE_CASES.STARTUP];
  let restarts = 0;
  let answers = 0;
  let blocked = 0;
  try {
    const free = await unifiedFreeJourney(run, signal);
    cases.push(
      PAID_ACCEPTANCE_CASES.FREE,
      PAID_ACCEPTANCE_CASES.FREE_CLI,
      PAID_ACCEPTANCE_CASES.FREE_CANCEL,
      PAID_ACCEPTANCE_CASES.FREE_RECEIPTS,
    );
    await run.reprice(OFFER_PRICING_KINDS.PAID);
    restarts++;
    await paidPreSend(run, signal);
    cases.push(PAID_ACCEPTANCE_CASES.PRESEND);
    await paidTerminal(run, signal, false);
    answers++;
    cases.push(PAID_ACCEPTANCE_CASES.CLI_ANSWER);
    await run.restart(false);
    restarts++;
    await paidTerminal(run, signal, true);
    cases.push(PAID_ACCEPTANCE_CASES.CLI_INTERRUPTED);
    await run.restart(true);
    restarts++;
    await paidTerminal(run, signal, true, true);
    cases.push(PAID_ACCEPTANCE_CASES.CLI_RECONCILED);
    await run.restart(true);
    restarts++;
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
    assertPaidJsonAnswer(unverifiedBody, PAID_VERDICTS.UNVERIFIED);
    await uncertain(run, signal);
    blocked++;
    // A free listing must not bypass a previous uncertain authorization, even after buyer restart.
    const preparations = run.paymentPreparations();
    await run.reprice(OFFER_PRICING_KINDS.FREE);
    await uncertain(run, signal);
    assert.equal(run.paymentPreparations(), preparations);
    cases.push(PAID_ACCEPTANCE_CASES.FREE_PENDING);
    blocked++;
    await run.reprice(OFFER_PRICING_KINDS.PAID);
    restarts += 2;
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
    await paidWait(() => run.engine.cancellations() === 2, signal);
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
    return await finishPaidAcceptance(run.close, async () => {
      const telemetryEvents = await unifiedPrivateEvidence(free.receipts, true);
      cases.push(PAID_ACCEPTANCE_CASES.TELEMETRY);
      assert.equal(globalThis.fetch, originalFetch);
      assert.equal(run.external(), 0);
      assert.ok(run.registry.counts().reads > 0);
      assert.equal(run.registry.counts().forbidden, 0);
      assert.ok(run.reads() >= answers);
      assert.equal(
        run.payments.uniqueChannels(),
        run.payments.authorizations(),
      );
      cases.push(PAID_ACCEPTANCE_CASES.ISOLATION);
      return {
        ok: true,
        nativeIroh: true,
        simulatedChain: true,
        realPayments: false,
        cases: Object.values(PAID_ACCEPTANCE_CASES).filter((name) =>
          cases.includes(name),
        ),
        freeAnswers: free.freeAnswers,
        freeAttempts: free.freeAttempts,
        freePaymentPreparations: free.freePaymentPreparations,
        freeTokenizerLoads: free.freeTokenizerLoads,
        confirmedReceipts: free.confirmedReceipts,
        telemetryEvents,
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
    });
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
