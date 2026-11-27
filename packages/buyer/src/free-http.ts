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
import { desktopOpening } from '@gyblos/node/desktop-opening';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import { FREE_EXECUTION } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import type { DiagnosticSink } from '@gyblos/runtime/diagnostics';
import { acceptLoopbackHost } from '@gyblos/runtime/loopback-host';

import { buyerApiCaller } from './api-key-caller';
import { buyerApiKeyExecutors } from './api-key-execution';
import {
  chatApi,
  defaultChatApi,
  estimatedTokens,
  isCountTokensRoute,
  isModelsRoute,
  modelList,
  type ChatApi,
} from './chat-api';
import { readBody } from './chat-body';
import { replyError, replyJson, type ChatErrorClassifier } from './chat-errors';
import { routedInput, type ChatSettings } from './chat-route-input';
import { stoppedResult, stoppingStream } from './chat-stop';
import {
  CHAT_ROUTES,
  FREE_BUYER,
  FREE_BUYER_CODES,
  PAID_BUYER,
} from './constants';
import {
  createDesktopApi,
  desktopApiPolicy,
  type BuyerDesktopOptions,
} from './desktop-api';
import { FreeBuyerError } from './free-chat';
import {
  executeFreeSse,
  type ChatResult,
  type ChatStreamFormat,
  type FreeChatStreamExecutor,
} from './free-sse';
import { httpDiagnostics, httpRequestLifecycle } from './http-diagnostics';
import { listModels } from './model-list';
import { type RoutedModel } from './model-routes';
import { bearerAuthorizer } from './paid-token';
import { executionSlots } from './session-serial';

export type { ChatErrorClassifier, ChatErrorView } from './chat-errors';

// A complete answer: no delta callback, then the routed model in the stream executor's position, so one
// function may serve both.
type FreeChatExecutor = (
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  onDelta?: undefined,
  model?: RoutedModel,
  permission?: BuyerApiKeyOperation,
) => Promise<ChatResult>;
type ChatExecutors = {
  execute: FreeChatExecutor;
  stream?: FreeChatStreamExecutor;
};
function scheduledExecutors(
  schedule: ReturnType<typeof executionSlots>,
  { execute, stream }: ReturnType<typeof buyerApiKeyExecutors>,
): ChatExecutors {
  return {
    execute: (input, signal, delta, model) =>
      schedule(signal, () => execute(input, signal, delta, model)),
    stream:
      stream &&
      ((input, signal, delta, model) =>
        schedule(signal, () => stream(input, signal, delta, model))),
  };
}
function isJson(request: IncomingMessage) {
  const type = request.headers['content-type']?.split(';')[0]?.trim();
  return type?.toLowerCase() === FREE_BUYER.contentType;
}
function declaredTooLarge(request: IncomingMessage) {
  const length = Number(request.headers['content-length']);
  return Number.isFinite(length) && length > FREE_EXECUTION.requestBytes;
}
// The route's format for a request this endpoint can take now; anything else is answered here: the model
// list, or a refusal before the body is read, so a stalled oversize body holds no slot.
function admit(
  request: IncomingMessage,
  response: ServerResponse,
  full: boolean,
  desktopApi?: ChatApi,
): ChatApi | undefined {
  const local = request.headers.origin === undefined;
  const api = desktopApi ?? chatApi(request.url);
  const code =
    !api || request.method !== 'POST' || !local || !isJson(request)
      ? FREE_BUYER_CODES.INVALID
      : declaredTooLarge(request)
        ? FREE_BUYER_CODES.TOO_LARGE
        : full
          ? FREE_BUYER_CODES.BUSY
          : undefined;
  if (code === undefined) return api;
  if (code === FREE_BUYER_CODES.BUSY)
    response.setHeader(FREE_BUYER.retryAfterHeader, '1');
  replyError(response, new FreeBuyerError(code), undefined, api);
  return undefined;
}
const asksModels = (request: IncomingMessage) =>
  request.method === 'GET' &&
  isModelsRoute(request.url) &&
  request.headers.origin === undefined;
const asksTokenCount = (request: IncomingMessage) =>
  request.method === 'POST' &&
  isCountTokensRoute(request.url) &&
  request.headers.origin === undefined;
// Anthropic's count_tokens, which Claude Code may call to size its context; an estimate, never a seller call.
async function countTokens(
  request: IncomingMessage,
  response: ServerResponse,
  requestMs: number,
  diagnostic: ReturnType<ReturnType<typeof httpDiagnostics>>,
) {
  diagnostic.input();
  try {
    const body = await readBody(request, AbortSignal.timeout(requestMs));
    replyJson(response, estimatedTokens(body));
    diagnostic.success();
  } catch (error) {
    diagnostic.failure(error);
    replyError(response, error, undefined, chatApi(CHAT_ROUTES.messages));
  }
}
// The executors with the request's stop sequences honored on what the client sees (see chat-stop.ts).
function stopping(scoped: ChatExecutors, stops: string[] | undefined) {
  if (!stops) return scoped;
  const { execute, stream } = scoped;
  return {
    execute: async (...args: Parameters<FreeChatExecutor>) =>
      stoppedResult(await execute(...args), stops),
    stream: stream && stoppingStream(stream, stops),
  };
}
function expireRequest(
  request: IncomingMessage,
  response: ServerResponse,
  cancel: () => void,
  reply: () => void,
) {
  cancel();
  response.shouldKeepAlive = false;
  reply();
  if (response.writableEnded) response.once('close', () => request.destroy());
  else {
    request.destroy();
    response.destroy();
  }
}
function streamFormat(api: ChatApi, model: string, request: IncomingMessage) {
  return api.stream(
    model,
    request.headers[PAID_BUYER.observationHeader] ===
      PAID_BUYER.observationValue,
  );
}
async function serveChat(
  request: IncomingMessage,
  response: ServerResponse,
  settings: ChatSettings,
  scoped: ChatExecutors,
  api: ChatApi,
  requestMs: number,
  diagnostic: ReturnType<ReturnType<typeof httpDiagnostics>>,
  selectedSellerAllowed: boolean,
  classify?: ChatErrorClassifier,
) {
  let format: ChatStreamFormat | undefined;
  const lifecycle = httpRequestLifecycle(
    response,
    requestMs,
    diagnostic,
    (cancel) =>
      expireRequest(request, response, cancel, () =>
        replyError(
          response,
          new FreeBuyerError(FREE_BUYER_CODES.TIMEOUT),
          classify,
          api,
          format,
        ),
      ),
  );
  const controller = lifecycle.controller;
  try {
    const { input, payload, route, model } = routedInput(
      api,
      await readBody(request, controller.signal),
      settings,
      scoped.stream !== undefined,
      selectedSellerAllowed,
    );
    if (
      route.openingIntent &&
      !(await desktopOpening(process.env).armed(route.openingIntent))
    )
      throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
    const run = stopping(scoped, input.stop);
    diagnostic.executing();
    if (input.stream && run.stream) {
      format = streamFormat(api, model, request);
      await executeFreeSse(
        run.stream,
        payload,
        controller.signal,
        response,
        format,
        route,
      );
      diagnostic.responding();
      diagnostic.success();
      return;
    }
    const result = await run.execute(
      payload,
      controller.signal,
      undefined,
      route,
    );
    diagnostic.responding();
    if (!controller.signal.aborted) {
      replyJson(response, api.completion(model, result));
      diagnostic.success();
    }
  } catch (error) {
    diagnostic.failure(error);
    replyError(response, error, classify, api, format);
  } finally {
    lifecycle.close();
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
  diagnostics?: DiagnosticSink,
  preparePaidChat?: () => Promise<void>,
  reconcilePool?: () => Promise<void>,
  inspectChannel?: BuyerDesktopOptions['inspectChannel'],
) {
  const desktop = createDesktopApi(desktopPolicy, authorize !== undefined, {
    preparePaidChat,
    reconcilePool,
    inspectChannel,
  });
  const accept = buyerApiCaller(authorize, apiKeys, desktopPolicy);
  const observe = httpDiagnostics(diagnostics);
  let active = 0;
  const schedule = executionSlots(
    settings.parallel ?? TRANSPORT_LIMITS.maxConcurrent,
  );
  return async (request: IncomingMessage, response: ServerResponse) => {
    const diagnostic = observe();
    const caller = await accept(request, response);
    if (!caller) {
      diagnostic.refused();
      return;
    }
    if (await desktop.handled(request, response, caller.owner)) {
      if (response.statusCode >= HTTP_STATUS.badRequest) diagnostic.refused();
      return;
    }
    if (asksModels(request)) return listModels(response, settings);
    if (asksTokenCount(request))
      return countTokens(request, response, requestMs, diagnostic);
    const channelRoute =
      request.url?.split('?')[0] === BUYER_API.CHANNEL_CHAT_PATH;
    const localApi = desktop.accepts(request, isJson(request))
      ? defaultChatApi
      : undefined;
    const ownsChat = authorize && settings.sellerChoice && caller.owner;
    const selectedSellerAllowed = Boolean(ownsChat && localApi && channelRoute);
    if (channelRoute && !selectedSellerAllowed) {
      replyError(response, new FreeBuyerError(FREE_BUYER_CODES.INVALID));
      return;
    }
    const full = active >= FREE_BUYER.maxHttpRequests;
    const api = admit(request, response, full, localApi);
    if (!api) {
      if (response.statusCode >= HTTP_STATUS.badRequest) diagnostic.refused();
      return;
    }
    diagnostic.input();
    active++;
    try {
      await serveChat(
        request,
        response,
        settings,
        scheduledExecutors(
          schedule,
          buyerApiKeyExecutors(apiKeys, caller.keyId, execute, stream),
        ),
        api,
        requestMs,
        diagnostic,
        selectedSellerAllowed,
        classify,
      );
    } finally {
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
    diagnostics?: DiagnosticSink;
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
      options.diagnostics,
      options.preparePaidChat,
      options.reconcilePool,
      options.inspectChannel,
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
