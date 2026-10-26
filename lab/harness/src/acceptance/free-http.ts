// Talks only to the product buyer HTTP server's allocated loopback address; never global fetch or RPC.
// Keeps synthetic content in memory and returns it only to internal assertions, not the report.
import { request } from 'node:http';

import { FREE_BUYER } from '@gyblos/buyer/constants';
import { HTTP_STATUS, ROUTES } from '@gyblos/config';
import { FREE_CHAT_ROLES, MODEL_IDS } from '@gyblos/protocol/constants';
import { controlObject } from '@gyblos/protocol/control-validation';

import { ACCEPTANCE, ACCEPTANCE_CODES } from './constants.js';
import { acceptanceAssert, AcceptanceError } from './errors.js';
import { FREE_ACCEPTANCE } from './free-constants.js';

export function acceptanceChat(url: string, signal: AbortSignal) {
  const address = new URL(url);
  acceptanceAssert(
    address.origin.startsWith(`${ACCEPTANCE.origin}:`) &&
      address.pathname === ROUTES.inference,
  );
  const combined = AbortSignal.any([
    signal,
    AbortSignal.timeout(ACCEPTANCE.queryMs),
  ]);
  return new Promise<{
    status: number;
    noRetry: string | string[] | undefined;
    value: unknown;
  }>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'POST',
        signal: combined,
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > FREE_ACCEPTANCE.httpResponseBytes) {
            response.destroy();
            reject(new AcceptanceError(ACCEPTANCE_CODES.FAILED));
          } else chunks.push(chunk);
        });
        response.on('error', () =>
          reject(new AcceptanceError(ACCEPTANCE_CODES.FAILED)),
        );
        response.on('end', () => {
          try {
            const value: unknown = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            );
            resolve({
              status: response.statusCode ?? 0,
              noRetry: response.headers[FREE_BUYER.noRetryHeader],
              value,
            });
          } catch {
            reject(new AcceptanceError(ACCEPTANCE_CODES.FAILED));
          }
        });
      },
    );
    outgoing.on('error', () =>
      reject(new AcceptanceError(ACCEPTANCE_CODES.FAILED)),
    );
    outgoing.end(
      JSON.stringify({
        model: MODEL_IDS.QWEN3_0_6B,
        messages: [
          { role: FREE_CHAT_ROLES.USER, content: 'synthetic acceptance input' },
        ],
        max_tokens: FREE_ACCEPTANCE.maxTokens,
        stream: false,
      }),
    );
  });
}
export function assertChatAnswer(
  response: Awaited<ReturnType<typeof acceptanceChat>>,
) {
  acceptanceAssert(response.status === HTTP_STATUS.ok);
  const row = controlObject(response.value, [
    'id',
    'object',
    'created',
    'model',
    'choices',
    'usage',
  ]);
  acceptanceAssert(
    row.object === FREE_BUYER.completionObject &&
      row.model === MODEL_IDS.QWEN3_0_6B,
  );
  acceptanceAssert(Array.isArray(row.choices) && row.choices.length === 1);
  const choice = controlObject(row.choices[0], [
    'index',
    'message',
    'finish_reason',
  ]);
  const message = controlObject(choice.message, ['role', 'content']);
  acceptanceAssert(
    message.role === FREE_CHAT_ROLES.ASSISTANT &&
      message.content === 'synthetic',
  );
  const usage = controlObject(row.usage, [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
  ]);
  acceptanceAssert(
    usage.prompt_tokens === 1 &&
      usage.completion_tokens === 1 &&
      usage.total_tokens === 2,
  );
}
