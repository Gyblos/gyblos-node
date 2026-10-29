// Parses the execution input and result shared by the free and paid channels and bounds wire sizes; never
// inspects prompt content beyond its declared bounds. Errors are free-execution codes that the
// paid boundary maps onto its own.
import { canonicalJson } from './canonical';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  PUBLIC_RECORD_LIMITS,
  type FreeChatRole,
} from './constants';
import { parseModelSelection } from './control-requests';
import type { InferenceOfferV2 } from './control-types';
import {
  controlArray,
  controlInteger,
  controlObject,
  controlReasoning,
} from './control-validation';
import type {
  FreeExecutionRequest,
  FreeExecutionResult,
  FreeExecutionStop,
} from './free-execution-types';
import {
  freeExecutionFail,
  freeExecutionText,
} from './free-execution-validation';

function role(value: unknown): FreeChatRole {
  for (const accepted of Object.values(FREE_CHAT_ROLES))
    if (value === accepted) return accepted;
  return freeExecutionFail();
}
function messages(value: unknown) {
  const entries = controlArray(value, FREE_EXECUTION.maxMessages);
  if (!entries.length) return freeExecutionFail();
  let bytes = 0;
  return entries.map((entry) => {
    const input = controlObject(entry, ['role', 'content']);
    const content = freeExecutionText(input.content, FREE_EXECUTION.inputBytes);
    bytes += new TextEncoder().encode(content).length;
    if (bytes > FREE_EXECUTION.inputBytes)
      return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
    return { role: role(input.role), content };
  });
}
export function boundedWire(value: unknown, maximum: number) {
  if (new TextEncoder().encode(canonicalJson(value)).length > maximum)
    return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
}
// Input bound to the quote: the same requestId, selection and reasoning, and a token maximum
// within the signed offer and model context.
export function parseExecutionInput(
  value: unknown,
  requestId: string,
  offered: InferenceOfferV2,
): FreeExecutionRequest['input'] {
  const params = controlObject(value, [
    'messages',
    'selection',
    'reasoning',
    'maxTokens',
  ]);
  const selection = parseModelSelection(params.selection);
  const reasoning = controlReasoning(params.reasoning);
  if (
    requestId !== offered.requestId ||
    canonicalJson(selection) !== canonicalJson(offered.selection) ||
    reasoning !== offered.reasoning
  )
    return freeExecutionFail(FREE_EXECUTION_CODES.BINDING);
  const maxTokens = controlInteger(
    params.maxTokens,
    1,
    PUBLIC_RECORD_LIMITS.maxContextTokens,
  );
  if (maxTokens > offered.maxTokens || maxTokens > offered.model.contextTokens)
    return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
  return {
    messages: messages(params.messages),
    selection,
    reasoning,
    maxTokens,
  };
}

// A completed generation's text, usage and finish reason, shared by both channels' terminals.
export function parseExecutionResult(value: unknown): FreeExecutionResult {
  const input = controlObject(value, ['text', 'usage', 'finishReason']);
  const usage = controlObject(input.usage, ['inputTokens', 'outputTokens']);
  if (
    input.finishReason !== ENGINE_DONE_REASONS.STOP &&
    input.finishReason !== ENGINE_DONE_REASONS.LENGTH
  )
    return freeExecutionFail();
  return {
    text: freeExecutionText(input.text, FREE_EXECUTION.outputBytes),
    usage: {
      inputTokens: controlInteger(
        usage.inputTokens,
        0,
        PUBLIC_RECORD_LIMITS.maxContextTokens,
      ),
      outputTokens: controlInteger(
        usage.outputTokens,
        0,
        PUBLIC_RECORD_LIMITS.maxContextTokens,
      ),
    },
    finishReason: input.finishReason,
  };
}

export const hasField = (value: unknown, key: string) =>
  !!value && typeof value === 'object' && Object.hasOwn(value, key);

// Which codes a channel accepts, which one carries a stop reason, and which may report delivered
// output; `fail` raises the channel's own invalid-shape error.
export interface FailureRules<Code extends string> {
  codes: readonly Code[];
  reasonCode: Code;
  deliveredCodes: readonly Code[];
  fail: () => never;
}

// Shape only: a reason exactly with reasonCode, delivered only with deliveredCodes.
export function parseExecutionFailure<Code extends string>(
  value: unknown,
  rules: FailureRules<Code>,
): { code: Code } & FreeExecutionStop {
  const hasReason = hasField(value, 'reason');
  const hasDelivered = hasField(value, 'delivered');
  const error = controlObject(value, [
    'code',
    ...(hasReason ? ['reason'] : []),
    ...(hasDelivered ? ['delivered'] : []),
  ]);
  const code = rules.codes.find((entry) => entry === error.code);
  if (!code) return rules.fail();
  if (
    hasReason !== (code === rules.reasonCode) ||
    (hasDelivered && !rules.deliveredCodes.includes(code))
  )
    return rules.fail();
  const reason = hasReason
    ? Object.values(FREE_EXECUTION_STOP_REASONS).find(
        (entry) => entry === error.reason,
      )
    : undefined;
  if (hasReason && !reason) return rules.fail();
  return {
    code,
    ...(reason ? { reason } : {}),
    ...(hasDelivered
      ? {
          delivered: {
            outputTokens: controlInteger(
              controlObject(error.delivered, ['outputTokens']).outputTokens,
              1,
              PUBLIC_RECORD_LIMITS.maxContextTokens,
            ),
          },
        }
      : {}),
  };
}
