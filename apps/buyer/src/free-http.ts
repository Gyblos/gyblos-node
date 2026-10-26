// Loopback-only non-streaming chat compatibility; validates input before selection or prompt transmission.
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
import { FREE_CHAT_ROLES, FREE_EXECUTION } from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  FreeExecutionError,
  type FreeExecutionBuildInput,
  type FreeExecutionResult,
} from '@gyblos/protocol/free-execution';
import { acceptLoopbackHost } from '@gyblos/runtime/loopback-host';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { FREE_BUYER, FREE_BUYER_CODES } from './constants.js';
import { FreeBuyerError, parseFreeChat } from './free-chat.js';
import { FreeSelectionFailure } from './free-execution.js';

type FreeChatExecutor = (
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
) => Promise<FreeExecutionResult>;
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
      throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
  }
}
function replyError(response: ServerResponse, error: unknown) {
  if (response.destroyed || response.writableEnded) return;
  const known =
    error instanceof FreeClientError ||
    error instanceof FreeExecutionError ||
    error instanceof FreeBuyerError;
  const selected =
    error instanceof FreeSelectionFailure ? error.decision : undefined;
  const code = known
    ? error.code
    : (selected?.code ?? FREE_BUYER_CODES.INTERNAL);
  const status =
    error instanceof FreeBuyerError && error.code === FREE_BUYER_CODES.INVALID
      ? HTTP_STATUS.badRequest
      : HTTP_STATUS.serviceUnavailable;
  response.writeHead(status, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      error: {
        message: code,
        type: FREE_BUYER.errorType,
        code,
        ...(selected && 'cooldownUntil' in selected
          ? { cooldownUntil: selected.cooldownUntil }
          : {}),
      },
    }),
  );
}
function replyCompletion(
  response: ServerResponse,
  model: string,
  result: FreeExecutionResult,
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
      }),
    );
}
export function freeBuyerHandler(
  execute: FreeChatExecutor,
  settings: ChatSettings,
) {
  let active = 0;
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!acceptLoopbackHost(request, response)) return;
    if (
      request.method !== 'POST' ||
      request.url !== ROUTES.inference ||
      request.headers.origin !== undefined
    ) {
      replyError(response, new FreeBuyerError(FREE_BUYER_CODES.INVALID));
      return;
    }
    if (active >= TRANSPORT_LIMITS.maxConcurrent) {
      replyError(response, new FreeBuyerError(FREE_BUYER_CODES.BUSY));
      return;
    }
    active++;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(() => {
      cancel();
      request.destroy();
      response.destroy();
    }, FREE_BUYER.requestMs);
    response.once('close', cancel);
    try {
      const input = parseFreeChat(
        await readBody(request, controller.signal),
        settings.selection,
        settings.maxTokens,
      );
      const result = await execute(input, controller.signal);
      if (!controller.signal.aborted)
        replyCompletion(response, settings.selection.modelId, result);
    } catch (error) {
      replyError(response, error);
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
  options: { port?: number } = {},
) {
  const server = createServer(
    {
      maxHeaderSize: FREE_BUYER.headers,
      headersTimeout: FREE_BUYER.headerMs,
      requestTimeout: FREE_BUYER.requestMs,
    },
    freeBuyerHandler(execute, settings),
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
