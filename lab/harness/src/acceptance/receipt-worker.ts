// Child-only scenario: real product startups, in-process index/provider and native loopback. Reports metadata only.
import { GYBLOS_ALPN } from '@gyblos/protocol/constants';
import { isMain, onShutdown } from '@gyblos/runtime';

import { ACCEPTANCE_CODES, ACCEPTANCE_INDEX } from './constants';
import { acceptanceAssert, AcceptanceError } from './errors';
import {
  RECEIPT_ACCEPTANCE_CASES,
  type ReceiptAcceptanceCase,
  type ReceiptAcceptanceReport,
} from './receipt-constants';
import { receiptIdentityPhases } from './receipt-identity';
import {
  cancelledAnswer,
  configuredCap,
  confirmedAnswer,
  failedAnswer,
  missingReceipt,
  restartReceiptRoles,
} from './receipt-phases';
import { startReceiptScenario } from './receipt-startup';
import { confirmedSnapshots, receiptRetention } from './receipt-state';
import { receiptTelemetry } from './receipt-telemetry';

export async function receiptScenario(
  signal: AbortSignal,
): Promise<ReceiptAcceptanceReport> {
  const run = await startReceiptScenario(signal);
  const cases: ReceiptAcceptanceCase[] = [];
  let answers = 0;
  let confirmed = 0;
  try {
    cases.push(
      RECEIPT_ACCEPTANCE_CASES.STARTUP,
      RECEIPT_ACCEPTANCE_CASES.DISCOVERY,
    );
    confirmed = await confirmedAnswer(run, false, signal);
    answers++;
    acceptanceAssert(run.binding.beforeFirst() === 0);
    cases.push(RECEIPT_ACCEPTANCE_CASES.COMPLETE);
    confirmed = await confirmedAnswer(run, true, signal);
    answers++;
    cases.push(RECEIPT_ACCEPTANCE_CASES.STREAM);
    await restartReceiptRoles(run);
    confirmed = await confirmedAnswer(run, false, signal);
    answers++;
    cases.push(RECEIPT_ACCEPTANCE_CASES.RESTART);
    const identity = await receiptIdentityPhases(run, signal);
    answers += identity.answers;
    confirmed = identity.confirmed;
    cases.push(...identity.cases);
    await missingReceipt(run, signal);
    answers++;
    cases.push(RECEIPT_ACCEPTANCE_CASES.RECEIPT_FAILURE);
    await cancelledAnswer(run, signal);
    cases.push(RECEIPT_ACCEPTANCE_CASES.CANCEL);
    await failedAnswer(run, signal);
    cases.push(RECEIPT_ACCEPTANCE_CASES.ENGINE_FAILURE);
    await configuredCap(run, signal);
    cases.push(RECEIPT_ACCEPTANCE_CASES.FREE_CAPS);
    const stored = await confirmedSnapshots(run.environment);
    await run.close();
    await receiptRetention(run.environment, stored.at(-1)!);
    cases.push(RECEIPT_ACCEPTANCE_CASES.PRIVACY);
    await receiptTelemetry(run.environment, answers, identity.refusals);
    cases.push(RECEIPT_ACCEPTANCE_CASES.TELEMETRY);
    acceptanceAssert(
      run.externalCalls() === 0 &&
        run.registry.counts().reads > 0 &&
        run.registry.counts().forbidden === 0 &&
        run.discoveryReads() >= answers &&
        run.binding.protocols().every((alpns) => !alpns.includes(GYBLOS_ALPN)),
    );
    cases.push(RECEIPT_ACCEPTANCE_CASES.NO_EXTERNAL);
    return {
      ok: true,
      nativeIroh: true,
      paymentsEnabled: false,
      identityEnabled: true,
      registryReads: run.registry.counts().reads,
      forbiddenRpcMethods: run.registry.counts().forbidden,
      identityRefusals: identity.refusals,
      index: ACCEPTANCE_INDEX,
      cases,
      answers,
      engineAttempts: run.provider.calls(),
      confirmed,
      externalCalls: run.externalCalls(),
      discoveryReads: run.discoveryReads(),
    };
  } finally {
    await run.close();
  }
}
async function main() {
  const controller = new AbortController();
  const dispose = onShutdown(() => controller.abort());
  try {
    console.log(JSON.stringify(await receiptScenario(controller.signal)));
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
  } finally {
    dispose();
  }
}
if (isMain(import.meta.url)) process.exitCode = await main();
