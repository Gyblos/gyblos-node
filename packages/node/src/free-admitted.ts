// Runs one verified, metered free request through the free policy and the common execution lifecycle:
// admission with every cap, generation, then finish (refunding a completed recounted sale) and release.
// Free generation has no deadline; the window only observes the request's cancellation.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import {
  freeExecutionFail as fail,
  FreeExecutionError,
  type FreeExecutionRequest,
  type FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';

import { runAdmittedExecution } from './execution';
import type { FreePolicy } from './policy-free';

const FREE_WINDOW_ERRORS = {
  timeout: new FreeExecutionError(FREE_EXECUTION_CODES.TIMEOUT),
  cancelled: () => new FreeExecutionError(FREE_EXECUTION_CODES.CANCELLED),
};

export async function runFreeAdmitted(
  policy: FreePolicy,
  request: FreeExecutionRequest,
  inputTokens: number,
  now: () => number,
  signal: AbortSignal,
  generate: (signal: AbortSignal) => Promise<FreeExecutionResponse>,
): Promise<FreeExecutionResponse> {
  const permit = await policy.admit(request, { inputTokens, now: now() });
  const nothing = { inputTokens, outputTokens: 0, completed: false };
  const run = await runAdmittedExecution({
    policy,
    permit,
    now,
    signal,
    errors: FREE_WINDOW_ERRORS,
    generate: async (window) => {
      const response = await generate(window);
      if (!response.result) return fail(FREE_EXECUTION_CODES.INTERNAL);
      return response;
    },
    measure: (generated) =>
      'value' in generated && generated.value.result
        ? { ...generated.value.result.usage, completed: true }
        : nothing,
    nothing,
  });
  if ('error' in run.generated) throw run.generated.error;
  return run.generated.value;
}
