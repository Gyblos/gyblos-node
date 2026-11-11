// Synthetic calls to the actual authenticated buyer HTTP entry; no content is logged or returned as evidence.
import assert from 'node:assert/strict';

import { BUYER_EXECUTION_FIELD, PAID_BUYER } from '@gyblos/buyer/constants';
import { HTTP_STATUS } from '@gyblos/config';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { FREE_CHAT_ROLES, MODEL_IDS } from '@gyblos/protocol/constants';
import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';

import type { HttpMultisellerHost } from './http-multiseller-host';
import { PAID_ACCEPTANCE } from './paid-acceptance-constants';

export async function httpMultiChat(
  host: HttpMultisellerHost,
  signal: AbortSignal = host.signal,
) {
  const response = await fetch(host.buyer().url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
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
  assert.equal(result.response.status, HTTP_STATUS.ok);
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
