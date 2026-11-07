// Strict verification report parser: accepts complete bounded evidence, never arbitrary worker data.
import { ACCEPTANCE_CODES } from '@gyblos/lab-harness/acceptance/constants';
import { AcceptanceError } from '@gyblos/lab-harness/acceptance/errors';
import {
  controlArray,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import {
  PAID_ACCEPTANCE_CASES,
  type PaidAcceptanceReport,
} from './paid-acceptance-constants';

export function parsePaidReport(text: string): PaidAcceptanceReport {
  try {
    const row = controlObject(JSON.parse(text), [
      'ok',
      'nativeIroh',
      'simulatedChain',
      'realPayments',
      'cases',
      'answers',
      'attempts',
      'deposits',
      'settlements',
      'restarts',
      'blocked',
      'externalCalls',
      'registryReads',
      'forbiddenRpcMethods',
      'freeAnswers',
      'freeAttempts',
      'freePaymentPreparations',
      'freeTokenizerLoads',
      'confirmedReceipts',
      'telemetryEvents',
    ]);
    const known = Object.values(PAID_ACCEPTANCE_CASES);
    const cases = controlArray(row.cases, known.length).map((value) => {
      const found = known.find((item) => item === value);
      if (!found) throw new Error();
      return found;
    });
    if (
      row.ok !== true ||
      row.nativeIroh !== true ||
      row.simulatedChain !== true ||
      row.realPayments !== false ||
      JSON.stringify(cases) !== JSON.stringify(known)
    )
      throw new Error();
    const answers = controlInteger(row.answers, 4);
    const freeAnswers = controlInteger(row.freeAnswers, 3, 3);
    const freeAttempts = controlInteger(row.freeAttempts, 4, 4);
    const confirmedReceipts = controlInteger(
      row.confirmedReceipts,
      freeAnswers,
      freeAnswers,
    );
    const attempts = controlInteger(row.attempts, answers + freeAttempts);
    const deposits = controlInteger(
      row.deposits,
      attempts - freeAttempts,
      attempts - freeAttempts,
    );
    const settlements = controlInteger(row.settlements, deposits, deposits);
    return {
      ok: true,
      nativeIroh: true,
      simulatedChain: true,
      realPayments: false,
      cases,
      answers,
      freeAnswers,
      freeAttempts,
      confirmedReceipts,
      freePaymentPreparations: controlInteger(
        row.freePaymentPreparations,
        0,
        0,
      ),
      freeTokenizerLoads: controlInteger(row.freeTokenizerLoads, 0, 0),
      telemetryEvents: controlInteger(
        row.telemetryEvents,
        freeAnswers * 2,
        freeAnswers * 2,
      ),
      attempts,
      deposits,
      settlements,
      restarts: controlInteger(row.restarts, 2),
      blocked: controlInteger(row.blocked, 2),
      externalCalls: controlInteger(row.externalCalls, 0, 0),
      registryReads: controlInteger(row.registryReads, 1),
      forbiddenRpcMethods: controlInteger(row.forbiddenRpcMethods, 0, 0),
    };
  } catch {
    throw new AcceptanceError(ACCEPTANCE_CODES.FAILED);
  }
}
