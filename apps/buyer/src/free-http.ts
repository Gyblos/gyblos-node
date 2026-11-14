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
  UNITS,
} from '@gyblos/config';
import type {
  BuyerApiKeyOperation,
  BuyerApiKeys,
} from '@gyblos/node/buyer-api-keys';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
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
import { acceptLoopbackHost } from '@gyblos/runtime/loopback-host';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

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
import { stoppedResult, stoppingStream, withoutStop } from './chat-stop';
import {
  CHAT_ROUTES,
  FREE_BUYER,
  FREE_BUYER_CODES,
  FREE_CHAT_DETAILS,
  OPENROUTER,
  PAID_BUYER,
  PAID_BUYER_CODES,
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
import {
  endpointRoutes,
  requestedModel,
  type ModelRoute,
  type RoutedModel,
} from './model-routes';
import { bearerAuthorizer } from './paid-token';

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
interface ChatSettings {
  selection: ModelSelection;
  maxTokens: number;
  tools?: boolean; // true only where every request runs on the free channel
  // The models served by name; absent, `selection` is the one model.
  models?: readonly ModelRoute[];
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
  settings: ChatSettings,
  active: number,
  desktopApi?: ChatApi,
): ChatApi | undefined {
  const local = request.headers.origin === undefined;
  if (request.method === 'GET' && isModelsRoute(request.url) && local) {
    replyJson(response, modelList(endpointRoutes(settings)));
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
const asksTokenCount = (request: IncomingMessage) =>
  request.method === 'POST' &&
  isCountTokensRoute(request.url) &&
  request.headers.origin === undefined;
// Anthropic's count_tokens, which Claude Code may call to size its context; an estimate, never a seller call.
async function countTokens(
  request: IncomingMessage,
  response: ServerResponse,
  requestMs: number,
) {
  try {
    const body = await readBody(request, AbortSignal.timeout(requestMs));
    replyJson(response, estimatedTokens(body));
  } catch (error) {
    replyError(response, error, undefined, chatApi(CHAT_ROUTES.messages));
  }
}
// The model a request names (or the first of its OpenRouter fallbacks that this endpoint serves), and its
// input parsed against that model's route. The answer echoes the name that matched. The fallback list and
// the buyer's own stop sequences are not part of what a seller receives.
function routedInput(
  api: ChatApi,
  body: unknown,
  settings: ChatSettings,
  streaming: boolean,
) {
  const { route, name } = requestedModel(
    endpointRoutes(settings),
    body,
    !!settings.models?.length,
  );
  const model = name ?? route.id;
  let request = body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { [OPENROUTER.fallbackField]: _fallbacks, ...rest } = body as Record<
      string,
      unknown
    >;
    request = name === undefined ? rest : { ...rest, model: name };
  }
  const input = api.parse(
    request,
    { ...route.selection, modelId: model },
    route.maxTokens,
    streaming,
    settings.tools ?? false,
  );
  const { stream: _stream, ...rest } = input; // all but the stream flag
  return { input, payload: withoutStop(rest), route, model };
}
// The executors with the request's stop sequences honored on what the client sees (see chat-stop.ts).
function stopping(
  scoped: { execute: FreeChatExecutor; stream?: FreeChatStreamExecutor },
  stops: string[] | undefined,
) {
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
  const accept = buyerApiCaller(authorize, apiKeys, desktopPolicy);
  let active = 0;
  return async (request: IncomingMessage, response: ServerResponse) => {
    const caller = await accept(request, response);
    if (!caller) return;
    const scoped = buyerApiKeyExecutors(apiKeys, caller.keyId, execute, stream);
    if (desktop.handled(request, response)) return;
    if (asksTokenCount(request))
      return countTokens(request, response, requestMs);
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
    const timer = setTimeout(
      () =>
        expireRequest(request, response, cancel, () =>
          replyError(
            response,
            new FreeBuyerError(FREE_BUYER_CODES.TIMEOUT),
            classify,
            api,
            format,
          ),
        ),
      requestMs,
    );
    response.once('close', cancel);
    try {
      const { input, payload, route, model } = routedInput(
        api,
        await readBody(request, controller.signal),
        settings,
        stream !== undefined,
      );
      const run = stopping(scoped, input.stop);
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
        return;
      }
      const result = await run.execute(
        payload,
        controller.signal,
        undefined,
        route,
      );
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
