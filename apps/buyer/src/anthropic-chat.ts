// The Anthropic Messages format over the same execution: system text apart, user and assistant turns with
// text content, a required max_tokens. Replies and errors take that API's shape so its SDKs and agents read
// them as they read Anthropic's own; Gyblos fields (payment, execution) are added alongside, as on the
// OpenAI route.
import { randomUUID } from 'node:crypto';

import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';

import { chatConversation, textOf, type ChatTurn } from './chat-messages';
import {
  ANTHROPIC_CHAT,
  CHAT_MESSAGE_DETAILS,
  FREE_CHAT_DETAILS,
  FREE_CHAT_FIELDS,
  HTTP_ERROR_KINDS,
} from './constants';
import {
  chatObject,
  checkFields,
  checkModel,
  checkStream,
  invalidChat,
  outputTokens,
  type FreeChatInput,
} from './free-chat';
import {
  executionFields,
  paymentFields,
  type ChatResult,
  type ChatStreamFormat,
} from './free-sse';

function system(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return [textOf(value, ANTHROPIC_CHAT.partFields)];
}

function turns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value) || value.length === 0)
    throw invalidChat(FREE_CHAT_FIELDS.MESSAGES, CHAT_MESSAGE_DETAILS.shape);
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw invalidChat(FREE_CHAT_FIELDS.MESSAGES, CHAT_MESSAGE_DETAILS.shape);
    const message = entry as Record<string, unknown>;
    if (
      Object.keys(message).some(
        (key) => !ANTHROPIC_CHAT.messageFields.includes(key),
      ) ||
      (message.role !== FREE_CHAT_ROLES.USER &&
        message.role !== FREE_CHAT_ROLES.ASSISTANT)
    )
      throw invalidChat(FREE_CHAT_FIELDS.MESSAGES, CHAT_MESSAGE_DETAILS.shape);
    return {
      role: message.role,
      text: textOf(message.content, ANTHROPIC_CHAT.partFields),
    };
  });
}

export function parseAnthropicChat(
  value: unknown,
  selection: ModelSelection,
  maximum: number,
  allowStreaming = false,
): FreeChatInput {
  const row = chatObject(value);
  checkFields(row, ANTHROPIC_CHAT.fields);
  checkModel(row, selection);
  const stream = checkStream(row, allowStreaming);
  if (row.max_tokens === undefined || row.max_tokens === null)
    throw invalidChat(
      FREE_CHAT_FIELDS.MAX_TOKENS,
      FREE_CHAT_DETAILS.anthropicMaxTokens,
    );
  return {
    messages: chatConversation(system(row.system), turns(row.messages)),
    maxTokens: outputTokens(
      row.max_tokens,
      FREE_CHAT_FIELDS.MAX_TOKENS,
      maximum,
    ),
    ...stream,
  };
}

export const anthropicStop = (reason: ChatResult['finishReason']) =>
  reason === ENGINE_DONE_REASONS.LENGTH ? 'max_tokens' : 'end_turn';

export const anthropicMessageId = () =>
  `msg_${randomUUID().replaceAll('-', '')}`;

export function anthropicMessage(model: string, result: ChatResult) {
  return {
    id: anthropicMessageId(),
    type: 'message',
    role: FREE_CHAT_ROLES.ASSISTANT,
    model,
    content: [{ type: 'text', text: result.text }],
    stop_reason: anthropicStop(result.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
    },
    ...paymentFields(result.payment),
    ...executionFields(result),
  };
}

// Anthropic's error kinds by HTTP status; the Gyblos code and reason ride along for diagnosis.
export function anthropicErrorKind(status: number) {
  return HTTP_ERROR_KINDS[status] ?? HTTP_ERROR_KINDS.default;
}

// Anthropic's stream: message_start and one text block opened before the first text, text deltas, then the
// block's stop, the stop reason with usage, and message_stop.
export function anthropicStream(model: string): ChatStreamFormat {
  const id = anthropicMessageId();
  return {
    open: () =>
      event('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: FREE_CHAT_ROLES.ASSISTANT,
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }) +
      event('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    delta: (text) =>
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }),
    close: (result) =>
      event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      event('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: anthropicStop(result.finishReason),
          stop_sequence: null,
        },
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        },
        ...paymentFields(result.payment),
        ...executionFields(result),
      }) +
      event('message_stop', { type: 'message_stop' }),
    error: (code, stop, payment) =>
      event('error', {
        type: 'error',
        error: {
          type: HTTP_ERROR_KINDS.default,
          message: code,
          code,
          ...(stop.reason ? { reason: stop.reason } : {}),
          ...(stop.delivered
            ? { usage: { output_tokens: stop.delivered.outputTokens } }
            : {}),
          ...paymentFields(payment),
        },
      }),
  };
}

const event = (name: string, data: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
