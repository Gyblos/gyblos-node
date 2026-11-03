// Loopback-only complete/streaming chat compatibility; validates input before selection or prompt transmission.
// Responses and errors contain no transport details; request content is never persisted.
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  HTTP_STATUS,
  LOCALHOST,
  PORTS,
  ROUTES,
  TRANSPORT_LIMITS,
  UNITS,
} from '@gyblos/config';
import {
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  FreeExecutionError,
  type FreeExecutionBuildInput,
  type FreeExecutionResult,
  type FreeExecutionStop,
} from '@gyblos/protocol/free-execution';
import { acceptLoopbackHost } from '@gyblos/runtime/loopback-host';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import {
  FREE_BUYER,
  FREE_BUYER_CODES,
  FREE_CHAT_DETAILS,
  PAID_BUYER,
  PAID_BUYER_CODES,
} from './constants';
import { FreeBuyerError, invalidChat, parseFreeChat } from './free-chat';
import { FreeSelectionFailure } from './free-execution';
import {
  executeFreeSse,
  paymentFields,
  replyFreeSseError,
  type ChatErrorCode,
  type ChatPayment,
  type ChatResult,
  type FreeChatStreamExecutor,
} from './free-sse';
import { bearerAuthorizer } from './paid-token';

type FreeChatExecutor = (
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
) => Promise<ChatResult>;
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
interface ChatSettings {
  selection: ModelSelection;
  maxTokens: number;
}
async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > FREE_EXECUTION.requestBytes)
      throw new FreeBuyerError(FREE_BUYER_CODES.TOO_LARGE);
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw invalidChat(null, FREE_CHAT_DETAILS.json);
  }
}
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
        : undefined,
  };
}
function replyError(
  response: ServerResponse,
  error: unknown,
  classify?: ChatErrorClassifier,
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
    replyFreeSseError(response, code, stop, view.payment);
    return;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  // OpenAI SDKs retry 408/409/429/5xx by default; a resend after a possible send would repeat the
  // prompt, possibly to another seller. Only local BUSY and unsent unavailability stay retryable.
  const callerFault = view.status < HTTP_STATUS.internalServerError;
  if (
    view.status !== HTTP_STATUS.tooManyRequests &&
    (callerFault || !view.neverSent)
  )
    headers[FREE_BUYER.noRetryHeader] = 'false';
  response.writeHead(view.status, headers).end(
    JSON.stringify({
      error: {
        // A refused request explains itself; every other error keeps its code as the message.
        message: view.detail || code,
        type: FREE_BUYER.errorType,
        param: view.param ?? null,
        code,
        // Delivered usage only exists mid-stream, so a JSON error carries the reason alone.
        ...(stop.reason ? { reason: stop.reason } : {}),
        ...(view.cooldownUntil !== undefined
          ? { cooldownUntil: view.cooldownUntil }
          : {}),
        ...paymentFields(view.payment),
      },
    }),
  );
}
// A loopback Host, then in paid mode the bearer token: loopback is not authentication, and any local
// process could otherwise spend. The refusal comes before the body is read, and the connection closes
// rather than draining an unread body.
function acceptCaller(
  request: IncomingMessage,
  response: ServerResponse,
  authorize?: (request: IncomingMessage) => boolean,
) {
  if (!acceptLoopbackHost(request, response)) return false;
  if (!authorize || authorize(request)) return true;
  response.shouldKeepAlive = false;
  const code = PAID_BUYER_CODES.UNAUTHORIZED;
  response
    .writeHead(HTTP_STATUS.unauthorized, {
      'content-type': 'application/json',
      'www-authenticate': PAID_BUYER.authScheme,
      [FREE_BUYER.noRetryHeader]: 'false',
    })
    .end(
      JSON.stringify({
        error: { message: code, type: FREE_BUYER.errorType, param: null, code },
      }),
    );
  return false;
}
// Browsers can send "simple" cross-site POSTs only as form or text bodies; requiring JSON forces a
// preflight, which is refused, on top of the Origin rejection.
function isJson(request: IncomingMessage) {
  const type = request.headers['content-type']?.split(';')[0]?.trim();
  return type?.toLowerCase() === FREE_BUYER.contentType;
}
function declaredTooLarge(request: IncomingMessage) {
  const length = Number(request.headers['content-length']);
  return Number.isFinite(length) && length > FREE_EXECUTION.requestBytes;
}
function replyCompletion(
  response: ServerResponse,
  model: string,
  result: ChatResult,
) {
  if (response.destroyed || response.writableEnded) return;
  response
    .writeHead(HTTP_STATUS.ok, { 'content-type': 'application/json' })
    .end(
      JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: FREE_BUYER.completionObject,
        created: Math.floor(Date.now() / UNITS.millisecondsPerSecond),
        model,
        choices: [
          {
            index: 0,
            message: { role: FREE_CHAT_ROLES.ASSISTANT, content: result.text },
            finish_reason: result.finishReason,
          },
        ],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        },
        ...paymentFields(result.payment),
      }),
    );
}
export function freeBuyerHandler(
  execute: FreeChatExecutor,
  settings: ChatSettings,
  requestMs: number = FREE_BUYER.requestMs,
  stream?: FreeChatStreamExecutor,
  classify?: ChatErrorClassifier,
  authorize?: (request: IncomingMessage) => boolean,
) {
  let active = 0;
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!acceptCaller(request, response, authorize)) return;
    if (
      request.method !== 'POST' ||
      request.url !== ROUTES.inference ||
      request.headers.origin !== undefined ||
      !isJson(request)
    ) {
      replyError(response, new FreeBuyerError(FREE_BUYER_CODES.INVALID));
      return;
    }
    // Refused before admission and before reading, so a stalled oversize body holds no slot.
    if (declaredTooLarge(request)) {
      replyError(response, new FreeBuyerError(FREE_BUYER_CODES.TOO_LARGE));
      return;
    }
    if (active >= TRANSPORT_LIMITS.maxConcurrent) {
      replyError(response, new FreeBuyerError(FREE_BUYER_CODES.BUSY));
      return;
    }
    active++;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    // The prompt may already be on its way, so the deadline answers with no-retry rather than a
    // bare socket reset, which OpenAI SDKs would retry. The socket closes once the reply is out.
    const timer = setTimeout(() => {
      cancel();
      response.shouldKeepAlive = false;
      replyError(
        response,
        new FreeBuyerError(FREE_BUYER_CODES.TIMEOUT),
        classify,
      );
      // Destroying the request also ends a stalled body read, so its finally frees the slot.
      if (response.writableEnded)
        response.once('close', () => request.destroy());
      else {
        request.destroy();
        response.destroy();
      }
    }, requestMs);
    response.once('close', cancel);
    try {
      const input = parseFreeChat(
        await readBody(request, controller.signal),
        settings.selection,
        settings.maxTokens,
        stream !== undefined,
      );
      const payload = { messages: input.messages, maxTokens: input.maxTokens };
      if (input.stream && stream) {
        await executeFreeSse(
          stream,
          payload,
          controller.signal,
          response,
          settings.selection.modelId,
          request.headers[PAID_BUYER.observationHeader] ===
            PAID_BUYER.observationValue,
        );
        return;
      }
      const result = await execute(payload, controller.signal);
      if (!controller.signal.aborted)
        replyCompletion(response, settings.selection.modelId, result);
    } catch (error) {
      replyError(response, error, classify);
    } finally {
      clearTimeout(timer);
      response.removeListener('close', cancel);
      active--;
    }
  };
}
export async function startFreeBuyerHttp(
  execute: FreeChatExecutor,
  settings: ChatSettings,
  options: {
    port?: number;
    requestMs?: number;
    stream?: FreeChatStreamExecutor;
    classify?: ChatErrorClassifier;
    // Paid mode only: the bearer token every request must carry.
    token?: string;
  } = {},
) {
  const server = createServer(
    {
      maxHeaderSize: FREE_BUYER.headers,
      headersTimeout: FREE_BUYER.headerMs,
      requestTimeout: FREE_BUYER.requestMs,
    },
    freeBuyerHandler(
      execute,
      settings,
      options.requestMs,
      options.stream,
      options.classify,
      options.token === undefined ? undefined : bearerAuthorizer(options.token),
    ),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? PORTS.buyerProxy, LOCALHOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new FreeBuyerError(FREE_BUYER_CODES.INTERNAL);
  return {
    url: `http://${LOCALHOST}:${address.port}${ROUTES.inference}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
