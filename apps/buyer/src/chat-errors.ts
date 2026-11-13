// How the local endpoint answers a failure: the status, whether a client may retry (only when the prompt
// certainly never left this process), Retry-After while sellers cool down, and the body in each API's
// shape. A stream that already started gets an error event instead.
import type { ServerResponse } from 'node:http';

import { HTTP_STATUS, UNITS } from '@gyblos/config';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import {
  FreeExecutionError,
  type FreeExecutionStop,
} from '@gyblos/protocol/free-execution';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { defaultChatApi, type ChatApi } from './chat-api';
import { FREE_BUYER, FREE_BUYER_CODES, FREE_CHAT_DETAILS } from './constants';
import { FreeBuyerError } from './free-chat';
import { FreeSelectionFailure } from './free-execution';
import {
  replyFreeSseError,
  type ChatErrorCode,
  type ChatPayment,
  type ChatStreamFormat,
} from './free-sse';

// How an error is answered: its code and status, whether the prompt certainly never left this
// process (only then may a client retry), and the stop and payment it carries.
export interface ChatErrorView {
  code: ChatErrorCode;
  status: number;
  neverSent: boolean;
  stop: FreeExecutionStop;
  detail?: string;
  param?: string | null;
  cooldownUntil?: number;
  payment?: ChatPayment;
}
// Answers the errors of another executor (the paid one); undefined leaves the free answer.
export type ChatErrorClassifier = (error: unknown) => ChatErrorView | undefined;
// True only when the prompt certainly never left this process; anything else may have been sent.
function neverSent(error: unknown) {
  if (error instanceof FreeClientError) return !error.sent && !error.remote;
  if (error instanceof FreeExecutionError) return !error.remote;
  if (error instanceof FreeBuyerError)
    return error.code !== FREE_BUYER_CODES.TIMEOUT;
  return error instanceof FreeSelectionFailure;
}
function errorStatus(error: unknown, code: string) {
  if (code === FREE_BUYER_CODES.INVALID) return HTTP_STATUS.badRequest;
  if (code === FREE_BUYER_CODES.TOO_LARGE) return HTTP_STATUS.payloadTooLarge;
  if (code === FREE_EXECUTION_CODES.LIMIT) return HTTP_STATUS.badRequest;
  if (code === FREE_BUYER_CODES.BUSY) return HTTP_STATUS.tooManyRequests;
  if (code === FREE_BUYER_CODES.TIMEOUT) return HTTP_STATUS.gatewayTimeout;
  if (code === FREE_BUYER_CODES.MODEL) return HTTP_STATUS.notFound;
  if (
    error instanceof FreeClientError ||
    error instanceof FreeExecutionError ||
    error instanceof FreeBuyerError ||
    error instanceof FreeSelectionFailure
  )
    return HTTP_STATUS.serviceUnavailable;
  return HTTP_STATUS.internalServerError;
}
function freeErrorView(error: unknown): ChatErrorView {
  const known =
    error instanceof FreeClientError ||
    error instanceof FreeExecutionError ||
    error instanceof FreeBuyerError;
  const selected =
    error instanceof FreeSelectionFailure ? error.decision : undefined;
  const code = known
    ? error.code
    : (selected?.code ?? FREE_BUYER_CODES.INTERNAL);
  return {
    code,
    status: errorStatus(error, code),
    neverSent: neverSent(error),
    stop:
      error instanceof FreeClientError || error instanceof FreeExecutionError
        ? error
        : {},
    detail: error instanceof FreeBuyerError ? error.detail : undefined,
    param: error instanceof FreeBuyerError ? error.param : null,
    cooldownUntil:
      selected && 'cooldownUntil' in selected
        ? selected.cooldownUntil
        : error instanceof FreeSelectionFailure
          ? error.retryAt
          : undefined,
  };
}
// Seconds until a cooling seller may be tried again, for Retry-After, which SDKs honor when retrying.
const secondsUntil = (time: number) =>
  Math.max(1, Math.ceil((time - Date.now()) / UNITS.millisecondsPerSecond));
export function replyError(
  response: ServerResponse,
  error: unknown,
  classify?: ChatErrorClassifier,
  api: ChatApi = defaultChatApi,
  stream?: ChatStreamFormat,
) {
  if (response.destroyed || response.writableEnded) return;
  // A body cut off mid-stream leaves unread bytes, so the connection cannot be reused.
  if (
    error instanceof FreeBuyerError &&
    error.code === FREE_BUYER_CODES.TOO_LARGE
  )
    response.shouldKeepAlive = false;
  const view = classify?.(error) ?? freeErrorView(error);
  const { code, stop } = view;
  if (response.headersSent) {
    if (stream) replyFreeSseError(response, stream, code, stop, view.payment);
    else response.destroy();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const status = api.errorStatus?.(view.status, view.neverSent) ?? view.status;
  // OpenAI and Anthropic SDKs retry 408/409/429/5xx by default; a resend after a possible send would
  // repeat the prompt, possibly to another seller. Only local BUSY and unsent unavailability stay retryable.
  const callerFault = status < HTTP_STATUS.internalServerError;
  if (
    status !== HTTP_STATUS.tooManyRequests &&
    (callerFault || !view.neverSent)
  )
    headers[FREE_BUYER.noRetryHeader] = 'false';
  const retry =
    view.neverSent && view.cooldownUntil !== undefined
      ? secondsUntil(view.cooldownUntil)
      : undefined;
  if (retry !== undefined) headers[FREE_BUYER.retryAfterHeader] = String(retry);
  response.writeHead(status, headers).end(
    JSON.stringify(
      api.error({
        code,
        status,
        neverSent: view.neverSent,
        // A refused request explains itself; every other error keeps its code as the message.
        message:
          view.detail ||
          (retry !== undefined ? FREE_CHAT_DETAILS.coolingDown(retry) : code),
        param: view.param ?? null,
        // Delivered usage only exists mid-stream, so a JSON error carries the reason alone.
        extra: {
          ...(stop.reason ? { reason: stop.reason } : {}),
          ...(view.cooldownUntil !== undefined
            ? { cooldownUntil: view.cooldownUntil }
            : {}),
        },
        payment: view.payment,
      }),
    ),
  );
}
// Browsers can send "simple" cross-site POSTs only as form or text bodies; requiring JSON forces a
// preflight, which is refused, on top of the Origin rejection.
export function replyJson(response: ServerResponse, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response
    .writeHead(HTTP_STATUS.ok, { 'content-type': 'application/json' })
    .end(JSON.stringify(body));
}
