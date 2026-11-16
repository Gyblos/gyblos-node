// Independent recount for legacy individual settlement: full text conversations where supported.
// Tool requests require reusable sessions, whose buyer signs only after verifying the complete terminal.

import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { ChatTokenizer, RecountTokenizer } from '@gyblos/protocol/engine';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import {
  inferenceNeedsTools,
  type InferenceResult,
} from '@gyblos/protocol/inference';
import type {
  PaidCharge,
  PaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_DELIVERED_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';
import { checkToolCalls, isToolConversation } from '@gyblos/protocol/tools';

import { paidCharge } from './paid-charge';

// Legacy input preflight before payment construction/authorization; tools require an acknowledged session.
export function recountPaidInput(
  input: FreeExecutionBuildInput,
  meter: RecountTokenizer & Partial<Pick<ChatTokenizer, 'chat'>>,
) {
  if (inferenceNeedsTools(input)) return undefined;
  const [message, ...rest] = input.messages;
  if (!isToolConversation(input.messages)) return undefined;
  try {
    if (meter.chat) {
      return {
        prompt: message!.content,
        inputTokens: meter.chat(input.messages, input.tools, input.toolChoice),
      };
    }
    if (!message || rest.length || message.role !== FREE_CHAT_ROLES.USER)
      return undefined;
    return {
      prompt: message.content,
      inputTokens: meter.input(message.content),
    };
  } catch {
    return undefined;
  }
}

export function paidPrompt(
  input: FreeExecutionBuildInput,
  meter: Parameters<typeof recountPaidInput>[1],
): string | undefined {
  return recountPaidInput(input, meter)?.prompt;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

// `stop` is the seller's stop code, or undefined for a completed result.
export function paidRecount(
  request: PaidExecutionRequest,
  meter: RecountTokenizer & Partial<Pick<ChatTokenizer, 'chat'>>,
  prompt: string,
  received: string,
  stop: PaidExecutionCode | undefined,
  result?: InferenceResult,
): PaidCharge {
  if (result) checkToolCalls(request.input, result.toolCalls);
  const outputTokens = !received
    ? 0
    : stop === undefined
      ? meter.count(received)
      : PAID_DELIVERED_CODES.includes(stop)
        ? Math.min(Math.max(1, meter.count(received)), bytes(received))
        : 0;
  return paidCharge(
    request,
    {
      inputTokens: meter.chat
        ? meter.chat(
            request.input.messages,
            request.input.tools,
            request.input.toolChoice,
          )
        : meter.input(prompt),
      outputTokens,
    },
    outputTokens > 0,
  );
}
