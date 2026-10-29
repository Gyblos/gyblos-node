// Parses the execution input shared by the free and paid channels and bounds wire sizes; never
// inspects prompt content beyond its declared bounds. Errors are free-execution codes that the
// paid boundary maps onto its own.
import { canonicalJson } from './canonical';
import {
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
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
import type { FreeExecutionRequest } from './free-execution-types';
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
