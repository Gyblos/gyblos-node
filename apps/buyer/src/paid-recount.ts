// The buyer's own count of a paid request, made exactly as the seller counts: the single user message as
// input, the streamed text as output, and a stop that reports delivery at least one token and at most
// its bytes (other stops charge no output). Pure; the tokenizer is the model's public one.
import { paidCharge } from '@gyblos/core/paid-charge';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import type {
  PaidCharge,
  PaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_DELIVERED_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';

// The prompt a paid seller would count, or undefined for input no paid seller serves.
export function paidPrompt(input: FreeExecutionBuildInput): string | undefined {
  const [message, ...rest] = input.messages;
  if (!message || rest.length > 0 || message.role !== FREE_CHAT_ROLES.USER)
    return undefined;
  return message.content;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

// `stop` is the seller's stop code, or undefined for a completed result.
export function paidRecount(
  request: PaidExecutionRequest,
  meter: RecountTokenizer,
  prompt: string,
  received: string,
  stop: PaidExecutionCode | undefined,
): PaidCharge {
  const outputTokens = !received
    ? 0
    : stop === undefined
      ? meter.count(received)
      : PAID_DELIVERED_CODES.includes(stop)
        ? Math.min(Math.max(1, meter.count(received)), bytes(received))
        : 0;
  return paidCharge(
    request,
    { inputTokens: meter.input(prompt), outputTokens },
    outputTokens > 0,
  );
}
