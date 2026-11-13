// The three chat formats the local endpoint speaks over one execution: OpenAI chat completions, Anthropic
// messages and OpenAI responses. Each knows how to read a request, spell a complete answer, a stream and an error.
import { randomUUID } from 'node:crypto';

import { HTTP_STATUS, ROUTES, UNITS } from '@gyblos/config';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';

import {
  anthropicErrorKind,
  anthropicMessage,
  anthropicStream,
  parseAnthropicChat,
} from './anthropic-chat';
import { openAiCallsOut } from './chat-tools';
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
import type { ModelRoute } from './model-routes';
import { parseResponsesChat } from './responses-chat';
import {
  responsesCompletion,
  responsesError,
  responsesStream,
} from './responses-output';

export interface ChatErrorBody {
  code: ChatErrorCode;
  status: number;
  neverSent: boolean;
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
    // False where the endpoint may route to paid execution, which serves text only.
    allowTools?: boolean,
  ): FreeChatInput;
  completion(model: string, result: ChatResult): unknown;
  stream(model: string, includeDigest: boolean): ChatStreamFormat;
  error(body: ChatErrorBody): unknown;
  errorStatus?(status: number, neverSent: boolean): number;
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
        message: {
          role: FREE_CHAT_ROLES.ASSISTANT,
          // A turn that only calls tools has no content, as OpenAI writes it.
          content: result.text || (result.toolCalls ? null : ''),
          ...(result.toolCalls
            ? { tool_calls: openAiCallsOut(result.toolCalls) }
            : {}),
        },
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

// OpenAI's Responses API, which Codex CLI speaks.
const responses: ChatApi = {
  parse: parseResponsesChat,
  completion: responsesCompletion,
  stream: (model) => responsesStream(model),
  error: responsesError,
  // Codex retries HTTP 5xx without consulting x-should-retry. A possible send must stop it.
  errorStatus: (status, neverSent) =>
    neverSent ? status : HTTP_STATUS.badRequest,
};

// The format a path speaks; a query string (some clients add one) does not change the route.
export function chatApi(url: string | undefined): ChatApi | undefined {
  const path = url?.split('?')[0];
  if (path === ROUTES.inference) return openAi;
  if (path === CHAT_ROUTES.messages) return anthropic;
  if (path === CHAT_ROUTES.responses) return responses;
  return undefined;
}

export const isModelsRoute = (url: string | undefined) =>
  url?.split('?')[0] === CHAT_ROUTES.models;
export const isCountTokensRoute = (url: string | undefined) =>
  url?.split('?')[0] === CHAT_ROUTES.countTokens;

// Anthropic's token count, estimated: about four bytes per token over the request's system, messages and
// tools. The buyer holds no tokenizer for a free offer; agents use the count only to size their context.
export function estimatedTokens(body: unknown) {
  const row =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const text = JSON.stringify([row.system, row.messages, row.tools]);
  return {
    input_tokens: Math.ceil(Buffer.byteLength(text) / BYTES_PER_TOKEN),
  };
}
const BYTES_PER_TOKEN = 4;

// The one model this buyer asks for, in the OpenAI list shape that SDKs and agents read.
export function modelList(routes: readonly ModelRoute[]) {
  return {
    object: 'list',
    data: routes.map((route) => ({
      id: route.id,
      object: 'model',
      created: 0,
      owned_by: 'gyblos',
      // Anthropic's model list fields, for clients that read that shape.
      type: 'model',
      display_name: route.id,
      // The longest answer this endpoint asks a seller for on this model.
      max_output_tokens: route.maxTokens,
    })),
    has_more: false,
    first_id: routes[0]?.id ?? null,
    last_id: routes.at(-1)?.id ?? null,
  };
}

export const defaultChatApi = openAi;
