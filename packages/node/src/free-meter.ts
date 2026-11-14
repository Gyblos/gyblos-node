// How a free offer counts tokens. Recounted: the model's public tokenizer counts the prompt and every
// delivered text, as the buyer could. Declared: the engine's provider reports usage, which the buyer
// cannot check. The seller then relies on UTF-8 bytes, which never number fewer than tokens, refuses a
// count below the delivered text's byte floor and never refunds a reservation on the provider's word, so
// a provider that under-reports cannot stretch the token caps. Pure.
import { CONTROL_METERING_MODES } from '@gyblos/protocol/constants';
import type { ChatTokenizer, EngineUsage } from '@gyblos/protocol/engine';
import type { InferenceMeter as FreeMeter } from '@gyblos/protocol/inference';
import {
  toolMessageBytes,
  toolsBytes,
  type ToolCall,
  type ToolChatMessage,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import { FREE_METERING } from './constants';

export type {
  InferenceUsage as FreeUsage,
  InferenceMeter as FreeMeter,
} from '@gyblos/protocol/inference';

const bytes = (text: string) => new TextEncoder().encode(text).length;
// The fewest tokens text can hold when no token is longer than declaredMaxTokenBytes.
const tokenFloor = (text: string) =>
  text ? Math.ceil(bytes(text) / FREE_METERING.declaredMaxTokenBytes) : 0;

export function recountedMeter(tokenizer: ChatTokenizer): FreeMeter {
  return {
    mode: CONTROL_METERING_MODES.RECOUNTED,
    refunds: true,
    supportsToolCalls: Boolean(tokenizer.output),
    input: (prompt) => tokenizer.input(prompt),
    chat: (messages, tools, choice) => tokenizer.chat(messages, tools, choice),
    streamed: (text) => tokenizer.count(text),
    ...(tokenizer.stablePrefix ? { stablePrefix: tokenizer.stablePrefix } : {}),
    // A normalising tokenizer could count more tokens than bytes; the stream already bounded maxTokens.
    delivered: (text) =>
      Math.min(Math.max(1, tokenizer.count(text)), bytes(text)),
    // Calls count as the template writes them after the text; a tokenizer that cannot render them
    // cannot have offered tools.
    usage: (text, _reported, inputTokens, toolCalls) => ({
      inputTokens,
      outputTokens: toolCalls?.length
        ? tokenizer.output!(text, toolCalls)
        : tokenizer.count(text),
    }),
  };
}

export const DECLARED_METER: FreeMeter = Object.freeze({
  mode: CONTROL_METERING_MODES.DECLARED,
  refunds: false,
  supportsToolCalls: true,
  input: (prompt: string) =>
    bytes(prompt) + FREE_METERING.declaredTemplateTokens,
  // Each message's bytes and the template allowance per message, so a lone user message counts as its
  // prompt does.
  chat: (
    messages: readonly ToolChatMessage[],
    tools?: readonly ToolDefinition[],
  ) =>
    messages.reduce<number>(
      (sum, message) =>
        sum + toolMessageBytes(message) + FREE_METERING.declaredTemplateTokens,
      toolsBytes(tools),
    ),
  streamed: tokenFloor,
  delivered: (text: string, maxTokens: number) =>
    Math.min(bytes(text), maxTokens),
  usage: (
    text: string,
    reported: EngineUsage,
    _inputTokens: number,
    toolCalls?: readonly ToolCall[],
  ) =>
    Number.isSafeInteger(reported.inputTokens) &&
    Number.isSafeInteger(reported.outputTokens) &&
    reported.inputTokens >= 1 &&
    reported.outputTokens >=
      tokenFloor(
        text +
          (toolCalls ?? []).map((call) => call.name + call.arguments).join(''),
      )
      ? {
          inputTokens: reported.inputTokens,
          outputTokens: reported.outputTokens,
        }
      : undefined,
});
