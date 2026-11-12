// Bounded requests to the child-owned HTTP buyer only; no fetch bypass for arbitrary origins.
import { request } from 'node:http';

import { HTTP_STATUS, LOCALHOST } from '@gyblos/config';
import { isJsonFields, type JsonFields } from '@gyblos/core/engine-provider';

import { acceptanceAssert } from './errors';
import { receiptBody } from './receipt-http';
import { TOOL_ACCEPTANCE } from './tools-constants';
import { anthropicToolBlocks } from './tools-events';
import { TOOL_FIXTURE } from './tools-fixtures';

export function toolHttp(
  url: string,
  body: unknown,
  signal: AbortSignal,
  token?: string,
) {
  const target = new URL(url);
  acceptanceAssert(
    target.protocol === 'http:' && target.hostname === LOCALHOST,
  );
  const pending = request(target, {
    method: 'POST',
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(TOOL_ACCEPTANCE.ioMs),
    ]),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const response = new Promise<import('node:http').IncomingMessage>(
    (resolve, reject) => {
      pending.once('response', resolve);
      pending.once('error', reject);
    },
  );
  pending.end(JSON.stringify(body));
  return { response, cancel: () => pending.destroy() };
}
function fields(value: unknown): JsonFields {
  acceptanceAssert(isJsonFields(value));
  return value;
}
function first(value: unknown) {
  acceptanceAssert(Array.isArray(value) && value.length > 0);
  return fields(value[0]);
}
export async function verifyToolAnswer(
  response: import('node:http').IncomingMessage,
  anthropic: boolean,
  streaming: boolean,
  followup: boolean,
) {
  acceptanceAssert(response.statusCode === HTTP_STATUS.ok);
  const body = await receiptBody(response);
  const events = streaming
    ? body
        .split('\n')
        .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
        .map((line) =>
          fields(JSON.parse(line.slice('data: '.length)) as unknown),
        )
    : [fields(JSON.parse(body) as unknown)];
  acceptanceAssert(events.length > 0 && !events.some((event) => event.error));
  if (anthropic) {
    const done = streaming
      ? events.find((event) => event.type === 'message_delta')
      : events[0];
    acceptanceAssert(done);
    const usage = fields(done.usage);
    acceptanceAssert(
      usage.input_tokens === TOOL_ACCEPTANCE.inputTokens &&
        usage.output_tokens === TOOL_ACCEPTANCE.outputTokens,
    );
    acceptanceAssert(
      (streaming ? fields(done.delta) : done).stop_reason ===
        (followup ? 'end_turn' : 'tool_use'),
    );
    if (streaming) acceptanceAssert(events.at(-1)?.type === 'message_stop');
    const blocks = streaming
      ? anthropicToolBlocks(events)
      : events.flatMap((event) => {
          acceptanceAssert(Array.isArray(event.content));
          return event.content.map(fields);
        });
    if (followup) {
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      acceptanceAssert(
        text === TOOL_FIXTURE.final &&
          !blocks.some((block) => block.type === 'tool_use'),
      );
    } else {
      acceptanceAssert(
        blocks.filter((block) => block.type === 'tool_use').length === 1,
      );
      const call = blocks.find((block) => block.type === 'tool_use');
      acceptanceAssert(
        call?.id === TOOL_FIXTURE.id && call.name === TOOL_FIXTURE.name,
      );
      acceptanceAssert(
        fields(call.input).zone === 'UTC' &&
          Object.keys(fields(call.input)).length === 1,
      );
    }
  } else {
    const usage = fields(events.at(-1)!.usage);
    acceptanceAssert(
      usage.prompt_tokens === TOOL_ACCEPTANCE.inputTokens &&
        usage.completion_tokens === TOOL_ACCEPTANCE.outputTokens,
    );
    const choices = events.map((event) => first(event.choices));
    acceptanceAssert(
      choices.at(-1)?.finish_reason === (followup ? 'stop' : 'tool_calls'),
    );
    if (streaming) acceptanceAssert(body.endsWith('data: [DONE]\n\n'));
    const messages = choices.map((choice) =>
      fields(streaming ? choice.delta : choice.message),
    );
    if (followup)
      acceptanceAssert(
        messages.map((message) => message.content ?? '').join('') ===
          TOOL_FIXTURE.final && !messages.some((message) => message.tool_calls),
      );
    else {
      const message = messages.find((message) => message.tool_calls);
      acceptanceAssert(message);
      acceptanceAssert(
        Array.isArray(message.tool_calls) && message.tool_calls.length === 1,
      );
      const call = first(message.tool_calls);
      const fn = fields(call.function);
      acceptanceAssert(
        call.id === TOOL_FIXTURE.id &&
          call.type === 'function' &&
          fn.name === TOOL_FIXTURE.name &&
          fn.arguments === TOOL_FIXTURE.arguments,
      );
    }
  }
}
