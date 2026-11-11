// Serializes incremental free answers to the supported OpenAI-compatible SSE subset.
// Backpressure is awaited; disconnects/abort stop writes, and failures never emit a success terminal.
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import { HTTP_STATUS, UNITS } from '@gyblos/config';
import type { BuyerRoutingCode } from '@gyblos/core/constants';
import type { SessionApproval } from '@gyblos/node/session-accounting';
import {
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  type FreeExecutionCode,
  type OfferPricingKind,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import type {
  FreeExecutionBuildInput,
  FreeExecutionResult,
  FreeExecutionStop,
} from '@gyblos/protocol/free-execution';
import type { PaidExecutionCode } from '@gyblos/protocol/paid/constants';
import type { SessionCode } from '@gyblos/protocol/payment-session';

import {
  BUYER_EXECUTION_FIELD,
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
  session?: SessionApproval;
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
export type ChatResult = FreeExecutionResult & {
  payment?: ChatPayment;
  execution?: OfferPricingKind;
};
export const executionFields = (result: ChatResult) =>
  result.execution ? { [BUYER_EXECUTION_FIELD]: result.execution } : {};

export type ChatErrorCode =
  | BuyerRoutingCode
  | SessionCode
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
  data: string,
  signal: AbortSignal,
) {
  active(response, signal);
  if (response.write(data)) return;
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
// How a stream is spelled on the wire: OpenAI chunks, or Anthropic's named events.
export interface ChatStreamFormat {
  // Written once, before the first text; may be empty.
  open(): string;
  delta(text: string, first: boolean, requestDigest?: string): string;
  // Everything after the last text, through the stream's terminal marker.
  close(result: ChatResult): string;
  error(
    code: ChatErrorCode,
    stop: FreeExecutionStop,
    payment?: ChatPayment,
  ): string;
}

export async function executeFreeSse(
  execute: FreeChatStreamExecutor,
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  response: ServerResponse,
  format: ChatStreamFormat,
) {
  let text = '';
  let initial = true;
  const begin = async () => {
    active(response, signal);
    if (response.headersSent) return;
    response.writeHead(HTTP_STATUS.ok, {
      'content-type': FREE_BUYER.streamContentType,
      'cache-control': 'no-cache',
      [FREE_BUYER.noRetryHeader]: 'false',
    });
    const opening = format.open();
    if (opening) await write(response, opening, signal);
  };
  const result = await execute(
    input,
    signal,
    async (fragment, requestDigest) => {
      active(response, signal);
      if (Buffer.byteLength(text + fragment) > FREE_EXECUTION.outputBytes)
        throw new FreeBuyerError(FREE_BUYER_CODES.TOO_LARGE);
      text += fragment;
      await begin();
      await write(
        response,
        format.delta(fragment, initial, requestDigest),
        signal,
      );
      initial = false;
    },
  );
  active(response, signal);
  if (text !== result.text) throw new FreeBuyerError(FREE_BUYER_CODES.INTERNAL);
  await begin();
  await write(response, format.close(result), signal);
  active(response, signal);
  response.end();
}

const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

export function openAiStream(
  model: string,
  includeDigest = false,
): ChatStreamFormat {
  const header = {
    id: `chatcmpl-${randomUUID()}`,
    object: FREE_BUYER.chunkObject,
    created: Math.floor(Date.now() / UNITS.millisecondsPerSecond),
    model,
  };
  return {
    open: () => '',
    delta: (content, first, requestDigest) =>
      sse({
        ...header,
        ...(includeDigest && requestDigest
          ? { [PAID_BUYER.requestDigestField]: requestDigest }
          : {}),
        choices: [
          {
            index: 0,
            delta: {
              ...(first ? { role: FREE_CHAT_ROLES.ASSISTANT } : {}),
              content,
            },
            finish_reason: null,
          },
        ],
      }),
    close: (result) =>
      sse({
        ...header,
        choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        },
        ...paymentFields(result.payment),
        ...executionFields(result),
      }) + `data: ${FREE_BUYER.streamDone}\n\n`,
    // A seller that could not continue adds its reason and, when known, the completion tokens delivered.
    error: (code, stop, payment) =>
      sse({
        error: {
          message: code,
          type: FREE_BUYER.errorType,
          param: null,
          code,
          ...(stop.reason ? { reason: stop.reason } : {}),
          ...(stop.delivered
            ? { usage: { completion_tokens: stop.delivered.outputTokens } }
            : {}),
          ...paymentFields(payment),
        },
      }),
  };
}

export function replyFreeSseError(
  response: ServerResponse,
  format: ChatStreamFormat,
  code: ChatErrorCode,
  stop: FreeExecutionStop = {},
  payment?: ChatPayment,
) {
  if (response.destroyed || response.writableEnded) return;
  response.end(format.error(code, stop, payment));
}
