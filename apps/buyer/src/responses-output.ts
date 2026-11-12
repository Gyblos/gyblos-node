// Writes answers in OpenAI's Responses API shape, as Codex CLI reads them: a response with a message item for
// the text and a function_call item per call. Streamed, the events follow the order Codex parses:
// response.created, the message item's added / part / text deltas / done, each call's item added and done,
// then response.completed with usage. A failure is response.failed. Gyblos fields ride along on the response.
import { randomUUID } from 'node:crypto';

import { UNITS } from '@gyblos/config';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';

import type { ChatErrorBody } from './chat-api';
import { FREE_BUYER } from './constants';
import {
  executionFields,
  paymentFields,
  type ChatPayment,
  type ChatResult,
  type ChatStreamFormat,
} from './free-sse';

const hexId = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll('-', '')}`;
const now = () => Math.floor(Date.now() / UNITS.millisecondsPerSecond);

const textPart = (text: string) => ({
  type: 'output_text',
  text,
  annotations: [],
});
const messageItem = (id: string, text: string, status: string) => ({
  type: 'message',
  id,
  status,
  role: 'assistant',
  content: status === 'completed' ? [textPart(text)] : [],
});
const callItems = (result: ChatResult) =>
  (result.toolCalls ?? []).map((call) => ({
    type: 'function_call',
    id: hexId('fc'),
    status: 'completed',
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  }));
// The items of a whole answer: its text as a message (unless a turn only calls tools), then its calls.
function outputItems(messageId: string, result: ChatResult) {
  return [
    ...(result.text || !result.toolCalls?.length
      ? [messageItem(messageId, result.text, 'completed')]
      : []),
    ...callItems(result),
  ];
}
const usage = (result: ChatResult) => ({
  input_tokens: result.usage.inputTokens,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: result.usage.outputTokens,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: result.usage.inputTokens + result.usage.outputTokens,
});
const shell = (id: string, model: string, created: number) => ({
  id,
  object: 'response',
  created_at: created,
  model,
  error: null,
  incomplete_details: null,
});

function finished(
  id: string,
  model: string,
  created: number,
  result: ChatResult,
  output: unknown[],
) {
  const cut = result.finishReason === ENGINE_DONE_REASONS.LENGTH;
  return {
    ...shell(id, model, created),
    status: cut ? 'incomplete' : 'completed',
    incomplete_details: cut ? { reason: 'max_output_tokens' } : null,
    output,
    usage: usage(result),
    ...paymentFields(result.payment),
    ...executionFields(result),
  };
}

export function responsesCompletion(model: string, result: ChatResult) {
  return finished(
    hexId('resp'),
    model,
    now(),
    result,
    outputItems(hexId('msg'), result),
  );
}

export const responsesError = (body: ChatErrorBody) => ({
  error: {
    message: body.message,
    type: FREE_BUYER.errorType,
    param: body.param,
    code: body.code,
    ...body.extra,
    ...paymentFields(body.payment),
  },
});

type Emit = (type: string, data: Record<string, unknown>) => string;
type CallItem = ReturnType<typeof callItems>[number];

// One call's events: its item added without arguments, its arguments whole, and the finished item.
const callEvents = (event: Emit, item: CallItem, index: number) =>
  event('response.output_item.added', {
    output_index: index,
    item: { ...item, status: 'in_progress', arguments: '' },
  }) +
  event('response.function_call_arguments.done', {
    item_id: item.id,
    output_index: index,
    arguments: item.arguments,
  }) +
  event('response.output_item.done', { output_index: index, item });

const failed = (
  base: ReturnType<typeof shell>,
  code: string,
  stop: FreeExecutionStop,
  payment: ChatPayment | undefined,
) => ({
  ...base,
  status: 'failed',
  output: [],
  error: {
    code,
    message: code,
    ...(stop.reason ? { reason: stop.reason } : {}),
  },
  ...(stop.delivered
    ? { usage: { output_tokens: stop.delivered.outputTokens } }
    : {}),
  ...paymentFields(payment),
});

// One stream. The message item opens with the first text, so a turn that only calls tools has no empty
// message; every event carries its sequence number.
export function responsesStream(model: string): ChatStreamFormat {
  const id = hexId('resp');
  const messageId = hexId('msg');
  const created = now();
  let sequence = 0;
  let text = '';
  let opened = false;
  const event: Emit = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`;
  const at = { item_id: messageId, output_index: 0, content_index: 0 };
  const closeMessage = () =>
    !opened
      ? ''
      : event('response.output_text.done', { ...at, text }) +
        event('response.content_part.done', { ...at, part: textPart(text) }) +
        event('response.output_item.done', {
          output_index: 0,
          item: messageItem(messageId, text, 'completed'),
        });
  return {
    open: () =>
      event('response.created', {
        response: {
          ...shell(id, model, created),
          status: 'in_progress',
          output: [],
        },
      }),
    delta: (fragment) => {
      const start = opened
        ? ''
        : event('response.output_item.added', {
            output_index: 0,
            item: messageItem(messageId, '', 'in_progress'),
          }) +
          event('response.content_part.added', {
            ...at,
            part: textPart(''),
          });
      opened = true;
      text += fragment;
      return (
        start + event('response.output_text.delta', { ...at, delta: fragment })
      );
    },
    close: (result) => {
      // Events are numbered as written: the message closes before the calls open.
      const message = closeMessage();
      const first = opened ? 1 : 0;
      const calls = callItems(result);
      const items = calls
        .map((item, offset) => callEvents(event, item, first + offset))
        .join('');
      const output = [
        ...(opened ? [messageItem(messageId, text, 'completed')] : []),
        ...calls,
      ];
      return (
        message +
        items +
        event('response.completed', {
          response: finished(id, model, created, result, output),
        })
      );
    },
    error: (code, stop, payment) =>
      event('response.failed', {
        response: failed(shell(id, model, created), code, stop, payment),
      }),
  };
}
