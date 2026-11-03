// Serializes incremental free answers to the supported OpenAI-compatible SSE subset.
// Backpressure is awaited; disconnects/abort stop writes, and failures never emit a success terminal.
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import { HTTP_STATUS, UNITS } from '@gyblos/config';
import {
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  type FreeExecutionCode,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import type {
  FreeExecutionBuildInput,
  FreeExecutionResult,
  FreeExecutionStop,
} from '@gyblos/protocol/free-execution';
import type { PaidExecutionCode } from '@gyblos/protocol/paid/constants';

import {
  FREE_BUYER,
  FREE_BUYER_CODES,
  PAID_BUYER,
  type FreeBuyerCode,
  type PaidBuyerCode,
} from './constants';
import { FreeBuyerError } from './free-chat';
import type { SelectionDecision } from './selection';

// What a paid request cost, as the buyer counted it and as the seller claimed; amounts are atomic
// units of the test token. A free request carries none.
export interface ChatPayment {
  verdict: string;
  maxAtomic: string;
  expectedAtomic: string;
  chargedAtomic: string | null;
  sellerAtomic: string | null;
  feeAtomic: string | null;
  refundedAtomic: string | null;
  // Whether the buyer kept a record for reconciliation; false for a settled request.
  recorded: boolean;
}
export type ChatResult = FreeExecutionResult & { payment?: ChatPayment };

export type ChatErrorCode =
  | FreeBuyerCode
  | PaidBuyerCode
  | FreeExecutionCode
  | PaidExecutionCode
  | PaymentErrorCode
  | Exclude<SelectionDecision, { ok: true }>['code'];

export const paymentFields = (payment: ChatPayment | undefined) =>
  payment ? { [PAID_BUYER.paymentField]: payment } : {};

export type FreeChatStreamExecutor = (
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  onDelta: (text: string, requestDigest?: string) => Promise<void>,
) => Promise<ChatResult>;
function active(response: ServerResponse, signal: AbortSignal) {
  if (signal.aborted || response.destroyed || response.writableEnded)
    throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
}
async function write(
  response: ServerResponse,
  data: unknown,
  signal: AbortSignal,
) {
  active(response, signal);
  if (response.write(`data: ${JSON.stringify(data)}\n\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.removeListener('drain', drained);
      response.removeListener('close', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE));
    };
    response.once('drain', drained);
    response.once('close', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted || response.destroyed) aborted();
  });
  active(response, signal);
}
export async function executeFreeSse(
  execute: FreeChatStreamExecutor,
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  response: ServerResponse,
  model: string,
  includeDigest = false,
) {
  const header = {
    id: `chatcmpl-${randomUUID()}`,
    object: FREE_BUYER.chunkObject,
    created: Math.floor(Date.now() / UNITS.millisecondsPerSecond),
    model,
  };
  let text = '';
  let initial = true;
  const begin = () => {
    active(response, signal);
    if (!response.headersSent)
      response.writeHead(HTTP_STATUS.ok, {
        'content-type': FREE_BUYER.streamContentType,
        'cache-control': 'no-cache',
        [FREE_BUYER.noRetryHeader]: 'false',
      });
  };
  const result = await execute(
    input,
    signal,
    async (fragment, requestDigest) => {
      active(response, signal);
      if (Buffer.byteLength(text + fragment) > FREE_EXECUTION.outputBytes)
        throw new FreeBuyerError(FREE_BUYER_CODES.TOO_LARGE);
      text += fragment;
      begin();
      await write(
        response,
        {
          ...header,
          ...(includeDigest && requestDigest
            ? { [PAID_BUYER.requestDigestField]: requestDigest }
            : {}),
          choices: [
            {
              index: 0,
              delta: {
                ...(initial ? { role: FREE_CHAT_ROLES.ASSISTANT } : {}),
                content: fragment,
              },
              finish_reason: null,
            },
          ],
        },
        signal,
      );
      initial = false;
    },
  );
  active(response, signal);
  if (text !== result.text) throw new FreeBuyerError(FREE_BUYER_CODES.INTERNAL);
  begin();
  await write(
    response,
    {
      ...header,
      choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
      usage: {
        prompt_tokens: result.usage.inputTokens,
        completion_tokens: result.usage.outputTokens,
        total_tokens: result.usage.inputTokens + result.usage.outputTokens,
      },
      ...paymentFields(result.payment),
    },
    signal,
  );
  active(response, signal);
  response.end(`data: ${FREE_BUYER.streamDone}\n\n`);
}
// A seller that could not continue adds its reason and, when known, the completion tokens delivered.
export function replyFreeSseError(
  response: ServerResponse,
  code: ChatErrorCode,
  stop: FreeExecutionStop = {},
  payment?: ChatPayment,
) {
  if (response.destroyed || response.writableEnded) return;
  const error = {
    message: code,
    type: FREE_BUYER.errorType,
    param: null,
    code,
    ...(stop.reason ? { reason: stop.reason } : {}),
    ...(stop.delivered
      ? { usage: { completion_tokens: stop.delivered.outputTokens } }
      : {}),
    ...paymentFields(payment),
  };
  response.end(`data: ${JSON.stringify({ error })}\n\n`);
}
