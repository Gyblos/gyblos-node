// The buyer's own count of a paid request, made exactly as the seller counts: the single user message as
// input, the streamed text as output, and a stopped stream's text at least one token and at most its
// bytes. Pure; the tokenizer is the model's public one.
import { paidCharge } from '@gyblos/core/paid-charge';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import type {
  PaidCharge,
  PaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';

// The prompt a paid seller would count, or undefined for input no paid seller serves.
export function paidPrompt(input: FreeExecutionBuildInput): string | undefined {
  const [message, ...rest] = input.messages;
  if (!message || rest.length > 0 || message.role !== FREE_CHAT_ROLES.USER)
    return undefined;
  return message.content;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

// `completed` is whether the seller's terminal is a result rather than a stop.
export function paidRecount(
  request: PaidExecutionRequest,
  meter: RecountTokenizer,
  prompt: string,
  received: string,
  completed: boolean,
): PaidCharge {
  const counted = received ? meter.count(received) : 0;
  const outputTokens =
    completed || !received
      ? counted
      : Math.min(Math.max(1, counted), bytes(received));
  return paidCharge(
    request,
    { inputTokens: meter.input(prompt), outputTokens },
    outputTokens > 0,
  );
}
