// Sends only synthetic input to the owned buyer's loopback endpoint; response bodies never enter reports.
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';

import { PAID_VERDICTS } from '@gyblos/buyer/constants';
import { FREE_CHAT_ROLES, MODEL_IDS } from '@gyblos/protocol/constants';

import {
  assertPaidJsonAnswer,
  assertPaidStreamAnswer,
} from './paid-acceptance-answers';
import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import type { PaidAcceptanceHost } from './paid-acceptance-host';

export function paidHttp(
  run: PaidAcceptanceHost,
  signal: AbortSignal,
  stream = false,
) {
  const url = new URL(run.url());
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  const token = run.token();
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      resolve,
    );
    outgoing.once('error', reject);
    outgoing.end(
      JSON.stringify({
        model: MODEL_IDS.QWEN3_0_6B,
        messages: [
          { role: FREE_CHAT_ROLES.USER, content: 'synthetic paid input' },
        ],
        max_tokens: PAID_ACCEPTANCE.maxTokens,
        stream,
      }),
    );
  });
}
export async function paidBody(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    assert.ok(Buffer.isBuffer(chunk));
    size += chunk.length;
    assert.ok(size <= PAID_ACCEPTANCE.outputBytes);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function paidAnswer(
  run: PaidAcceptanceHost,
  signal: AbortSignal,
  stream = false,
) {
  const before = run.engine.attempts();
  const response = await paidHttp(run, signal, stream);
  const body = await paidBody(response);
  assert.equal(response.statusCode, 200);
  if (stream) assertPaidStreamAnswer(body, response.headers['content-type']);
  else assertPaidJsonAnswer(body, PAID_VERDICTS.SETTLED);
  assert.equal(run.engine.attempts(), before + 1);
}
