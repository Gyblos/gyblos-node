// How a free offer counts tokens. Recounted: the model's public tokenizer counts the prompt and every
// delivered text, as the buyer could. Declared: the engine's provider reports usage, which the buyer
// cannot check. The seller then relies on UTF-8 bytes, which never number fewer than tokens, refuses a
// count below the delivered text's byte floor and never refunds a reservation on the provider's word, so
// a provider that under-reports cannot stretch the token caps. Pure.
import {
  CONTROL_METERING_MODES,
  type ControlMeteringMode,
} from '@gyblos/protocol/constants';
import type { ChatTokenizer, EngineUsage } from '@gyblos/protocol/engine';
import {
  toolMessageBytes,
  toolsBytes,
  type ToolCall,
  type ToolChatMessage,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import { FREE_METERING } from './constants';

export interface FreeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface FreeMeter {
  mode: ControlMeteringMode;
  // Whether a completion's count may return unused reserved tokens to the caps.
  refunds: boolean;
  // Never fewer than the prompt's tokens, so admission reserves enough against the context and caps.
  input(prompt: string): number;
  // The same for a whole conversation and any tools offered, as the model's template renders them.
  chat(
    messages: readonly ToolChatMessage[],
    tools?: readonly ToolDefinition[],
  ): number;
  // Never more than the text's tokens, so a stream stops before it delivers past maxTokens.
  streamed(text: string): number;
  // What a stop reports as delivered: at least one token for non-empty text, never more than its bytes.
  delivered(text: string, maxTokens: number): number;
  // The final usage, or undefined when a declared count is not plausible for the text; the caller
  // bounds it by maxTokens and the context as the buyer does.
  usage(
    text: string,
    reported: EngineUsage,
    inputTokens: number,
    toolCalls?: readonly ToolCall[],
  ): FreeUsage | undefined;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;
// The fewest tokens text can hold when no token is longer than declaredMaxTokenBytes.
const tokenFloor = (text: string) =>
  text ? Math.ceil(bytes(text) / FREE_METERING.declaredMaxTokenBytes) : 0;

export function recountedMeter(tokenizer: ChatTokenizer): FreeMeter {
  return {
    mode: CONTROL_METERING_MODES.RECOUNTED,
    refunds: true,
    input: (prompt) => tokenizer.input(prompt),
    chat: (messages, tools) => tokenizer.chat(messages, tools),
    streamed: (text) => tokenizer.count(text),
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
