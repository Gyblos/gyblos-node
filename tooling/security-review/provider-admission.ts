// Owns per-run provider admission and observed process and token counts.
import { REVIEW_FAILURE, type ReviewFailure } from './constants';
import type { runPi } from './pi';
import type { ReviewRunResult } from './types';

export class InvocationFailure extends Error {
  constructor(
    readonly code: ReviewFailure,
    readonly skipped = false,
  ) {
    super(code);
  }
}
export function providerAdmission(
  invoke: typeof runPi,
  execution: ReviewRunResult['execution'],
) {
  const admission: { stopped?: ReviewFailure } = {};
  const execute: typeof runPi = async (invocation) => {
    if (admission.stopped) throw new InvocationFailure(admission.stopped, true);
    if (!execution || execution.callsStarted >= execution.maxCalls)
      throw new InvocationFailure(REVIEW_FAILURE.BUDGET, true);
    execution.callsStarted += 1;
    let response;
    try {
      response = await invoke(invocation);
    } catch {
      throw new InvocationFailure(REVIEW_FAILURE.PI);
    }
    if (
      response.failure === REVIEW_FAILURE.QUOTA ||
      response.failure === REVIEW_FAILURE.KEY
    )
      admission.stopped ??= response.failure;
    if (response.reportedTokens !== undefined)
      execution.reportedTokens =
        (execution.reportedTokens ?? 0) + response.reportedTokens;
    return response;
  };
  return { admission, execute };
}
