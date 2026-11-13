// What a free request may ask of this offer, checked before admission: the quoted terms, a conversation
// the engine can render (with tools only when it serves them) and the input's tokens within the context.
import {
  prepareInference,
  validateInferenceInput,
} from '@gyblos/inference/conversation';
import { canonicalJson } from '@gyblos/protocol';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import {
  freeExecutionFail as fail,
  type FreeExecutionRequest,
} from '@gyblos/protocol/free-execution';
import { INFERENCE_CODES, InferenceError } from '@gyblos/protocol/inference';
import { type ToolChatMessage } from '@gyblos/protocol/tools';

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
  const { messages } = request.input;
  try {
    validateInferenceInput(request.input, options.engine, options.meter);
  } catch {
    return fail(FREE_EXECUTION_CODES.UNSUPPORTED);
  }
  if (request.input.maxTokens > options.offer.caps.maxOutputTokens)
    return fail(FREE_EXECUTION_CODES.LIMIT);
  return messages;
}

export function freeInputTokens(
  request: FreeExecutionRequest,
  messages: readonly ToolChatMessage[],
  options: InputOptions,
) {
  try {
    return prepareInference(
      { ...request.input, messages },
      {
        engine: options.engine,
        meter: options.meter,
        contextTokens: options.model.contextTokens,
      },
    );
  } catch (error) {
    return fail(
      error instanceof InferenceError && error.code === INFERENCE_CODES.LIMIT
        ? FREE_EXECUTION_CODES.LIMIT
        : FREE_EXECUTION_CODES.UNSUPPORTED,
    );
  }
}
