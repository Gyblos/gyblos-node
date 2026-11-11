// Loopback-only complete/streaming chat compatibility; validates input before selection or prompt transmission.
// Responses and errors contain no transport details; request content is never persisted.
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
} from '@gyblos/config';
import type {
  BuyerApiKeyOperation,
  BuyerApiKeys,
} from '@gyblos/node/buyer-api-keys';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  FreeExecutionError,
  type FreeExecutionBuildInput,
  type FreeExecutionStop,
} from '@gyblos/protocol/free-execution';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { acceptBuyerApiRequest } from './api-key-caller';
import { buyerApiKeyExecutors } from './api-key-execution';
import { buyerApiKeyErrorView } from './api-key-http';
import {
  chatApi,
  defaultChatApi,
  isModelsRoute,
  modelList,
  type ChatApi,
} from './chat-api';
import {
  FREE_BUYER,
  FREE_BUYER_CODES,
  FREE_CHAT_DETAILS,
  PAID_BUYER,
} from './constants';
import {
  createDesktopApi,
  desktopApiPolicy,
  type BuyerDesktopOptions,
} from './desktop-api';
import { FreeBuyerError, invalidChat } from './free-chat';
import { FreeSelectionFailure } from './free-execution';
import {
  executeFreeSse,
  replyFreeSseError,
  type ChatErrorCode,
  type ChatPayment,
  type ChatResult,
  type ChatStreamFormat,
  type FreeChatStreamExecutor,
} from './free-sse';
import { bearerAuthorizer } from './paid-token';

type FreeChatExecutor = (
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  onDelta?: (text: string, requestDigest?: string) => Promise<void>,
  permission?: BuyerApiKeyOperation,
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
  const keyError = buyerApiKeyErrorView(error);
  if (keyError) return keyError;
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
  // OpenAI and Anthropic SDKs retry 408/409/429/5xx by default; a resend after a possible send would
  // repeat the prompt, possibly to another seller. Only local BUSY and unsent unavailability stay retryable.
  const callerFault = view.status < HTTP_STATUS.internalServerError;
  if (
    view.status !== HTTP_STATUS.tooManyRequests &&
    (callerFault || !view.neverSent)
  )
    headers[FREE_BUYER.noRetryHeader] = 'false';
  response.writeHead(view.status, headers).end(
    JSON.stringify(
      api.error({
        code,
        status: view.status,
        // A refused request explains itself; every other error keeps its code as the message.
        message: view.detail || code,
        param: view.param ?? null,
        // Delivered usage only exists mid-stream, so a JSON error carries the reason alone.
        extra: {
          [BUYER_API.NEVER_SENT_FIELD]: view.neverSent,
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
function isJson(request: IncomingMessage) {
  const type = request.headers['content-type']?.split(';')[0]?.trim();
  return type?.toLowerCase() === FREE_BUYER.contentType;
}
function declaredTooLarge(request: IncomingMessage) {
  const length = Number(request.headers['content-length']);
  return Number.isFinite(length) && length > FREE_EXECUTION.requestBytes;
}
function replyJson(response: ServerResponse, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response
    .writeHead(HTTP_STATUS.ok, { 'content-type': 'application/json' })
    .end(JSON.stringify(body));
}
// The route's format for a request this endpoint can take now; anything else is answered here: the model
// list, or a refusal before the body is read, so a stalled oversize body holds no slot.
function admit(
  request: IncomingMessage,
  response: ServerResponse,
  settings: ChatSettings,
  active: number,
  desktopApi?: ChatApi,
): ChatApi | undefined {
  const local = request.headers.origin === undefined;
  if (request.method === 'GET' && isModelsRoute(request.url) && local) {
    replyJson(response, modelList(settings.selection));
    return undefined;
  }
  const api = desktopApi ?? chatApi(request.url);
  const code =
    !api || request.method !== 'POST' || !local || !isJson(request)
      ? FREE_BUYER_CODES.INVALID
      : declaredTooLarge(request)
        ? FREE_BUYER_CODES.TOO_LARGE
        : active >= TRANSPORT_LIMITS.maxConcurrent
          ? FREE_BUYER_CODES.BUSY
          : undefined;
  if (code === undefined) return api;
  replyError(response, new FreeBuyerError(code), undefined, api);
  return undefined;
}
function finishTimedOutRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  // Destroying the request ends a stalled body read and releases its admission slot.
  if (response.writableEnded) response.once('close', () => request.destroy());
  else {
    request.destroy();
    response.destroy();
  }
}
export function freeBuyerHandler(
  execute: FreeChatExecutor,
  settings: ChatSettings,
  requestMs: number = FREE_BUYER.requestMs,
  stream?: FreeChatStreamExecutor,
  classify?: ChatErrorClassifier,
  authorize?: (request: IncomingMessage) => boolean,
  desktopPolicy?: BuyerApiPolicy,
  apiKeys?: BuyerApiKeys,
) {
  const desktop = createDesktopApi(desktopPolicy, authorize !== undefined);
  let active = 0;
  return async (request: IncomingMessage, response: ServerResponse) => {
    const caller = await acceptBuyerApiRequest(
      request,
      response,
      authorize,
      apiKeys,
      desktopPolicy,
    );
    if (!caller) return;
    const scoped = buyerApiKeyExecutors(apiKeys, caller.keyId, execute, stream);
    if (desktop.handled(request, response)) return;
    const localApi = desktop.accepts(request, isJson(request))
      ? defaultChatApi
      : undefined;
    const api = admit(request, response, settings, active, localApi);
    if (!api) return;
    let format: ChatStreamFormat | undefined;
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
        api,
        format,
      );
      finishTimedOutRequest(request, response);
    }, requestMs);
    response.once('close', cancel);
    try {
      const input = api.parse(
        await readBody(request, controller.signal),
        settings.selection,
        settings.maxTokens,
        stream !== undefined,
      );
      const payload = { messages: input.messages, maxTokens: input.maxTokens };
      const model = settings.selection.modelId;
      if (input.stream && scoped.stream) {
        format = api.stream(
          model,
          request.headers[PAID_BUYER.observationHeader] ===
            PAID_BUYER.observationValue,
        );
        await executeFreeSse(
          scoped.stream,
          payload,
          controller.signal,
          response,
          format,
        );
        return;
      }
      const result = await scoped.execute(payload, controller.signal);
      if (!controller.signal.aborted)
        replyJson(response, api.completion(model, result));
    } catch (error) {
      replyError(response, error, classify, api, format);
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
    apiKeys?: BuyerApiKeys;
  } & BuyerDesktopOptions = {},
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
      desktopApiPolicy(options, settings),
      options.apiKeys,
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
