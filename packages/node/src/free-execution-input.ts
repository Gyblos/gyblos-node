// What a free request may ask of this offer, checked before admission: the quoted terms, a conversation
// the engine can render (with tools only when it serves them) and the input's tokens within the context.
import { canonicalJson } from '@gyblos/protocol';
import { isConversation, type ChatMessage } from '@gyblos/protocol/chat';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import {
  freeExecutionFail as fail,
  type FreeExecutionRequest,
} from '@gyblos/protocol/free-execution';
import {
  hasToolTurns,
  isToolConversation,
  type ToolChatMessage,
} from '@gyblos/protocol/tools';

import type { SellerFreeExecutionOptions } from './free-execution';

type InputOptions = Pick<
  SellerFreeExecutionOptions,
  'selection' | 'model' | 'capabilities' | 'offer' | 'engine' | 'meter'
>;

export function supportedInput(
  request: FreeExecutionRequest,
  options: InputOptions,
) {
  const offer = request.quote.offer;
  if (
    canonicalJson(offer.selection) !== canonicalJson(options.selection) ||
    canonicalJson(offer.model) !== canonicalJson(options.model) ||
    canonicalJson(offer.capabilities) !== canonicalJson(options.capabilities) ||
    !options.offer.reasoning.includes(offer.reasoning)
  )
    return fail(FREE_EXECUTION_CODES.UNSUPPORTED);
  const { messages, tools } = request.input;
  // Tools and tool turns need an engine that renders them; a text conversation keeps its strict shape.
  const usesTools = Boolean(tools) || hasToolTurns(messages);
  if (
    usesTools
      ? !options.engine.supportsTools?.() || !isToolConversation(messages)
      : !isConversation(messages as readonly ChatMessage[])
  )
    return fail(FREE_EXECUTION_CODES.UNSUPPORTED);
  if (request.input.maxTokens > options.offer.caps.maxOutputTokens)
    return fail(FREE_EXECUTION_CODES.LIMIT);
  return messages;
}

export function freeInputTokens(
  request: FreeExecutionRequest,
  messages: readonly ToolChatMessage[],
  options: InputOptions,
) {
  let inputTokens: number;
  try {
    inputTokens = options.meter.chat(messages, request.input.tools);
  } catch {
    // Text the model's template cannot carry (its control tokens, say) is input the offer cannot serve.
    return fail(FREE_EXECUTION_CODES.UNSUPPORTED);
  }
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    inputTokens + request.input.maxTokens > options.model.contextTokens
  )
    return fail(FREE_EXECUTION_CODES.LIMIT);
  return inputTokens;
}
