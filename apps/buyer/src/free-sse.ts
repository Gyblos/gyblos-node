// Serializes incremental free answers to the supported OpenAI-compatible SSE subset.
// Backpressure is awaited; disconnects/abort stop writes, and failures never emit a success terminal.
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import { HTTP_STATUS, UNITS } from '@gyblos/config';
import {
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  type FreeExecutionCode,
} from '@gyblos/protocol/constants';
import type {
  FreeExecutionBuildInput,
  FreeExecutionResult,
} from '@gyblos/protocol/free-execution';

import {
  FREE_BUYER,
  FREE_BUYER_CODES,
  type FreeBuyerCode,
} from './constants.js';
import { FreeBuyerError } from './free-chat.js';
import type { SelectionDecision } from './selection.js';

type FreeStreamErrorCode =
  | FreeBuyerCode
  | FreeExecutionCode
  | Exclude<SelectionDecision, { ok: true }>['code'];

export type FreeChatStreamExecutor = (
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  onDelta: (text: string) => Promise<void>,
) => Promise<FreeExecutionResult>;
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
  const result = await execute(input, signal, async (fragment) => {
    active(response, signal);
    if (Buffer.byteLength(text + fragment) > FREE_EXECUTION.outputBytes)
      throw new FreeBuyerError(FREE_BUYER_CODES.TOO_LARGE);
    text += fragment;
    begin();
    await write(
      response,
      {
        ...header,
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
  });
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
    },
    signal,
  );
  active(response, signal);
  response.end(`data: ${FREE_BUYER.streamDone}\n\n`);
}
export function replyFreeSseError(
  response: ServerResponse,
  code: FreeStreamErrorCode,
) {
  if (response.destroyed || response.writableEnded) return;
  response.end(
    `data: ${JSON.stringify({ error: { message: code, type: FREE_BUYER.errorType, param: null, code } })}\n\n`,
  );
}
