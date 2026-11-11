// The two chat formats the local endpoint speaks over one execution: OpenAI chat completions and Anthropic
// messages. Each knows how to read a request, spell a complete answer, a stream and an error.
import { randomUUID } from 'node:crypto';

import { ROUTES, UNITS } from '@gyblos/config';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';

import {
  anthropicErrorKind,
  anthropicMessage,
  anthropicStream,
  parseAnthropicChat,
} from './anthropic-chat';
import { CHAT_ROUTES, FREE_BUYER } from './constants';
import { parseFreeChat, type FreeChatInput } from './free-chat';
import {
  executionFields,
  openAiStream,
  paymentFields,
  type ChatErrorCode,
  type ChatPayment,
  type ChatResult,
  type ChatStreamFormat,
} from './free-sse';

export interface ChatErrorBody {
  code: ChatErrorCode;
  status: number;
  message: string;
  param: string | null;
  extra: Record<string, unknown>;
  payment?: ChatPayment;
}

export interface ChatApi {
  parse(
    value: unknown,
    selection: ModelSelection,
    maximum: number,
    allowStreaming: boolean,
  ): FreeChatInput;
  completion(model: string, result: ChatResult): unknown;
  stream(model: string, includeDigest: boolean): ChatStreamFormat;
  error(body: ChatErrorBody): unknown;
}

const openAi: ChatApi = {
  parse: parseFreeChat,
  completion: (model, result) => ({
    id: `chatcmpl-${randomUUID()}`,
    object: FREE_BUYER.completionObject,
    created: Math.floor(Date.now() / UNITS.millisecondsPerSecond),
    model,
    choices: [
      {
        index: 0,
        message: { role: FREE_CHAT_ROLES.ASSISTANT, content: result.text },
        finish_reason: result.finishReason,
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
    ...paymentFields(result.payment),
    ...executionFields(result),
  }),
  stream: openAiStream,
  error: (body) => ({
    error: {
      message: body.message,
      type: FREE_BUYER.errorType,
      param: body.param,
      code: body.code,
      ...body.extra,
      ...paymentFields(body.payment),
    },
  }),
};

const anthropic: ChatApi = {
  parse: parseAnthropicChat,
  completion: anthropicMessage,
  stream: (model) => anthropicStream(model),
  error: (body) => ({
    type: 'error',
    error: {
      type: anthropicErrorKind(body.status),
      message: body.message,
      code: body.code,
      ...(body.param ? { param: body.param } : {}),
      ...body.extra,
      ...paymentFields(body.payment),
    },
  }),
};

// The format a path speaks; a query string (some clients add one) does not change the route.
export function chatApi(url: string | undefined): ChatApi | undefined {
  const path = url?.split('?')[0];
  if (path === ROUTES.inference) return openAi;
  if (path === CHAT_ROUTES.messages) return anthropic;
  return undefined;
}

export const isModelsRoute = (url: string | undefined) =>
  url?.split('?')[0] === CHAT_ROUTES.models;

// The one model this buyer asks for, in the OpenAI list shape that SDKs and agents read.
export function modelList(selection: ModelSelection) {
  return {
    object: 'list',
    data: [
      {
        id: selection.modelId,
        object: 'model',
        created: 0,
        owned_by: 'gyblos',
        // Anthropic's model list fields, for clients that read that shape.
        type: 'model',
        display_name: selection.modelId,
      },
    ],
    has_more: false,
    first_id: selection.modelId,
    last_id: selection.modelId,
  };
}

export const defaultChatApi = openAi;
