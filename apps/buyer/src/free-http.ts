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

import {
  chatApi,
  defaultChatApi,
  estimatedTokens,
  isCountTokensRoute,
  isModelsRoute,
  modelList,
  type ChatApi,
} from './chat-api';
import { acceptCaller, readBody } from './chat-body';
import { replyError, replyJson, type ChatErrorClassifier } from './chat-errors';
import {
  CHAT_ROUTES,
  FREE_BUYER,
  FREE_BUYER_CODES,
  FREE_CHAT_DETAILS,
  PAID_BUYER,
  PAID_BUYER_CODES,
} from './constants';
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
  requestedRoute,
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
): ChatApi | undefined {
  const local = request.headers.origin === undefined;
  if (request.method === 'GET' && isModelsRoute(request.url) && local) {
    replyJson(response, modelList(endpointRoutes(settings)));
    return undefined;
  }
  const api = chatApi(request.url);
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
// The model a request names, and its input parsed against that model's route.
function routedInput(
  api: ChatApi,
  body: unknown,
  settings: ChatSettings,
  streaming: boolean,
) {
  const { route, name: model } = requestedRoute(endpointRoutes(settings), body);
  // The route was found by this name, so the format checks the name the client sent.
  const input = api.parse(
    body,
    { ...route.selection, modelId: model },
    route.maxTokens,
    streaming,
    settings.tools ?? false,
  );
  const { stream: _stream, ...payload } = input; // all but the stream flag
  return { input, payload, route, model };
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
    if (asksTokenCount(request))
      return countTokens(request, response, requestMs);
    const api = admit(request, response, settings, active);
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
      const { input, payload, route, model } = routedInput(
        api,
        await readBody(request, controller.signal),
        settings,
        stream !== undefined,
      );
      if (input.stream && stream) {
        format = api.stream(
          model,
          request.headers[PAID_BUYER.observationHeader] ===
            PAID_BUYER.observationValue,
        );
        await executeFreeSse(
          stream,
          payload,
          controller.signal,
          response,
          format,
          route,
        );
        return;
      }
      const result = await execute(
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
