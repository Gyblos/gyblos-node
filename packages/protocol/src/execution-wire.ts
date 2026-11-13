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
  ExecutionInput,
  ExecutionResult,
  FreeExecutionRequest,
  FreeExecutionResult,
  FreeExecutionStop,
} from './free-execution-types';
import {
  freeExecutionFail,
  freeExecutionText,
} from './free-execution-validation';
import {
  checkToolInput,
  parseToolCalls,
  parseToolChoice,
  parseToolMessage,
  parseTools,
  TOOL_CALLS_DONE,
  toolMessageBytes,
  toolsBytes,
  type ToolChatMessage,
  type ToolDefinition,
} from './tools';

function role(value: unknown): FreeChatRole {
  for (const accepted of Object.values(FREE_CHAT_ROLES))
    if (value === accepted) return accepted;
  return freeExecutionFail();
}
// The paid and batch channels keep the input bound they shipped with; free v4 passes its own.
export const PAID_INPUT_BYTES = 65536;
// The free channel's messages, which may also carry tool calls and results; tools and tool JSON count
// against the same input bound as text.
function toolMessages(
  value: unknown,
  inputBytes: number,
  maxMessages: number,
  tools: readonly ToolDefinition[] = [],
): ToolChatMessage[] {
  const entries = controlArray(value, maxMessages);
  if (!entries.length) return freeExecutionFail();
  let bytes = toolsBytes(tools);
  if (bytes > inputBytes) return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
  return entries.map((entry) => {
    const message = parseToolMessage(entry, role, inputBytes);
    bytes += toolMessageBytes(message);
    if (bytes > inputBytes)
      return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
    return message;
  });
}
export function boundedWire(value: unknown, maximum: number) {
  if (new TextEncoder().encode(canonicalJson(value)).length > maximum)
    return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
}
// The bound to the quote: the same requestId, selection and reasoning, and a token maximum within the
// signed offer and model context.
function boundInput(
  params: Record<string, unknown>,
  requestId: string,
  offered: InferenceOfferV2,
) {
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
  return { selection, reasoning, maxTokens };
}
const INPUT_KEYS = ['messages', 'selection', 'reasoning', 'maxTokens'];
// All active channels share tools and turns; their byte and message bounds remain explicit.
export function parseExecutionInput(
  value: unknown,
  requestId: string,
  offered: InferenceOfferV2,
  inputBytes: number = PAID_INPUT_BYTES,
  maxMessages: number = FREE_EXECUTION.maxMessages,
): ExecutionInput {
  const hasTools = hasField(value, 'tools');
  const hasChoice = hasField(value, 'toolChoice');
  const params = controlObject(value, [
    ...INPUT_KEYS,
    ...(hasTools ? ['tools'] : []),
    ...(hasChoice ? ['toolChoice'] : []),
  ]);
  const bound = boundInput(params, requestId, offered);
  const tools = hasTools ? parseTools(params.tools) : undefined;
  const toolChoice = hasChoice ? parseToolChoice(params.toolChoice) : undefined;
  checkToolInput({ tools, toolChoice });
  return {
    messages: toolMessages(params.messages, inputBytes, maxMessages, tools),
    ...bound,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
  };
}

export function parseFreeExecutionInput(
  value: unknown,
  requestId: string,
  offered: InferenceOfferV2,
): FreeExecutionRequest['input'] {
  return parseExecutionInput(
    value,
    requestId,
    offered,
    FREE_EXECUTION.inputBytes,
    FREE_EXECUTION.maxMessages,
  );
}
// Every active terminal shares the same result grammar.
export function parseExecutionResult(value: unknown): ExecutionResult {
  return parseResult(value);
}
export function parseFreeExecutionResult(value: unknown): FreeExecutionResult {
  return parseExecutionResult(value);
}
function parseResult(value: unknown): FreeExecutionResult {
  const calls = hasField(value, 'toolCalls');
  const input = controlObject(value, [
    'text',
    'usage',
    'finishReason',
    ...(calls ? ['toolCalls'] : []),
  ]);
  const usage = controlObject(input.usage, ['inputTokens', 'outputTokens']);
  if (calls !== (input.finishReason === TOOL_CALLS_DONE))
    return freeExecutionFail();
  if (
    !calls &&
    input.finishReason !== ENGINE_DONE_REASONS.STOP &&
    input.finishReason !== ENGINE_DONE_REASONS.LENGTH
  )
    return freeExecutionFail();
  return {
    text: freeExecutionText(input.text, FREE_EXECUTION.outputBytes),
    ...(calls ? { toolCalls: parseToolCalls(input.toolCalls) } : {}),
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
    finishReason: input.finishReason as FreeExecutionResult['finishReason'],
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
