// Synthetic calls to the actual authenticated buyer HTTP entry; no content is logged or returned as evidence.
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { IncomingMessage, ServerResponse } from 'node:http';

import {
  BUYER_EXECUTION_FIELD,
  BUYER_SELECTION_CODES,
  FREE_BUYER_CODES,
  PAID_BUYER,
  PAID_BUYER_CODES,
} from '@gyblos/buyer/constants';
import { HTTP_STATUS } from '@gyblos/config';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { FREE_CHAT_ROLES, MODEL_IDS } from '@gyblos/protocol/constants';
import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { batchDeferred } from './batch-deferred';
import { HTTP_MULTI } from './http-multiseller-constants';
import type { HttpMultisellerHost } from './http-multiseller-host';
import { PAID_ACCEPTANCE } from './paid-acceptance-constants';

export async function httpMultiChat(
  host: HttpMultisellerHost,
  signal: AbortSignal = host.signal,
  marker?: string,
) {
  const response = await fetch(host.buyer().url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      ...(marker ? { [HTTP_MULTI.traceHeader]: marker } : {}),
      authorization: `${PAID_BUYER.authScheme} ${await host.token()}`,
    },
    body: JSON.stringify({
      model: MODEL_IDS.QWEN3_0_6B,
      messages: [
        { role: FREE_CHAT_ROLES.USER, content: 'synthetic multi-seller input' },
      ],
      max_tokens: PAID_ACCEPTANCE.maxTokens,
      stream: false,
    }),
  });
  const text = await response.text();
  assert.ok(text.length <= PAID_ACCEPTANCE.outputBytes);
  const value: unknown = JSON.parse(text);

  return { response, value };
}
export function httpMultiText(seller: number) {
  return `${PAID_ACCEPTANCE.text}:${seller}`;
}
export function httpMultiAnswer(
  result: Awaited<ReturnType<typeof httpMultiChat>>,
  seller: number,
) {
  if (result.response.status !== HTTP_STATUS.ok) {
    const codes: ReadonlySet<unknown> = new Set([
      ...Object.values(BUYER_SELECTION_CODES),
      ...Object.values(FREE_BUYER_CODES),
      ...Object.values(PAID_BUYER_CODES),
      ...Object.values(BUYER_ROUTING_CODES),
      ...Object.values(PAID_EXECUTION_CODES),
    ]);
    const row = controlObject(result.value, ['error']);
    const error = controlObject(row.error, [
      'message',
      'type',
      'param',
      'code',
    ]);
    assert.fail(
      codes.has(error.code) ? String(error.code) : 'Synthetic HTTP failure',
    );
  }
  const row = controlObject(result.value, [
    'id',
    'object',
    'created',
    'model',
    'choices',
    'usage',
    PAID_BUYER.paymentField,
    BUYER_EXECUTION_FIELD,
  ]);
  const choices = controlArray(row.choices, 1);
  const choice = controlObject(choices[0], [
    'index',
    'message',
    'finish_reason',
  ]);
  const message = controlObject(choice.message, ['role', 'content']);
  assert.equal(message.content, httpMultiText(seller));
  const payment = controlObject(row[PAID_BUYER.paymentField], [
    'verdict',
    'maxAtomic',
    'expectedAtomic',
    'chargedAtomic',
    'sellerAtomic',
    'feeAtomic',
    'refundedAtomic',
    'recorded',
    'session',
  ]);
  assert.equal(payment.verdict, SESSION_VERDICTS.APPROVED);
  const usage = controlObject(row.usage, [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
  ]);
  assert.equal(usage.prompt_tokens, PAID_ACCEPTANCE.inputTokens);
  assert.equal(usage.completion_tokens, [...httpMultiText(seller)].length);
}
export function httpMultiError(
  result: Awaited<ReturnType<typeof httpMultiChat>>,
  code: string,
) {
  assert.ok(result.response.status >= HTTP_STATUS.badRequest);
  const row = controlObject(result.value, ['error']);
  const error = controlObject(row.error, ['message', 'type', 'param', 'code']);
  assert.equal(error.code, code);
}

// Native HTTP diagnostics observe admission/body consumption and server-side close, never payloads.
export function httpMultiHttpObservation(
  host: HttpMultisellerHost,
  marker: string,
) {
  const bodyRead = batchDeferred<void>();
  const closed = batchDeferred<void>();
  const events = channel('http.server.request.start');
  let request: IncomingMessage | undefined;
  let response: ServerResponse | undefined;
  const incoming = (value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('request' in value) ||
      !('response' in value)
    )
      return;
    if (
      !(value.request instanceof IncomingMessage) ||
      !(value.response instanceof ServerResponse)
    )
      return;
    if (
      value.request.headers[HTTP_MULTI.traceHeader] !== marker ||
      value.request.socket.localPort !== Number(new URL(host.buyer().url).port)
    )
      return;
    request = value.request;
    response = value.response;
    request.once('end', bodyRead.resolve);
    response.once('close', closed.resolve);
  };
  events.subscribe(incoming);
  return {
    bodyRead: bodyRead.promise,
    closed: closed.promise,
    dispose() {
      events.unsubscribe(incoming);
      request?.removeListener('end', bodyRead.resolve);
      response?.removeListener('close', closed.resolve);
    },
  };
}
