// A synthetic OpenAI-compatible server on loopback: `/v1/models` and streaming `/v1/chat/completions`,
// with every Engine contract behavior and a record of what each request carried. Test data only; no
// real provider, key or model.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import {
  CONTRACT_TEXT,
  UPSTREAM_MARKER,
  type EngineBehavior,
} from './engine-contract';

export const FAKE_OPENAI_MODEL = 'acme/chat-small';
export const HEADERS = { 'x-upstream': UPSTREAM_MARKER };
const STATUSES: Partial<Record<EngineBehavior, number>> = {
  'status-401': 401,
  'status-402': 402,
  'status-429': 429,
  'status-500': 500,
  'model-missing': 404,
};
const UPSTREAM_ERROR = JSON.stringify({
  error: { message: UPSTREAM_MARKER, type: 'server_error' },
});

export const sse = (value: unknown) =>
  `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
export const chunk = (content: string, extra: Record<string, unknown> = {}) =>
  sse({
    object: 'chat.completion.chunk',
    model: FAKE_OPENAI_MODEL,
    choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }],
  });
export const finish = (reason = 'stop') =>
  sse({
    object: 'chat.completion.chunk',
    model: FAKE_OPENAI_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  });
export const usage = (prompt = 3, completion = 2) =>
  sse({
    object: 'chat.completion.chunk',
    model: FAKE_OPENAI_MODEL,
    choices: [],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  });
export const DONE = sse('[DONE]');
export const COMPLETE =
  CONTRACT_TEXT.map((text) => chunk(text)).join('') + finish() + usage() + DONE;

// What the engine sent, for request-shape and secrecy assertions.
export interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

export type Completion = (response: ServerResponse) => void;

export function contractCompletion(behavior: EngineBehavior): Completion {
  return (response) => {
    const status = STATUSES[behavior];
    if (status !== undefined) {
      response.writeHead(status, HEADERS).end(UPSTREAM_ERROR);
      return;
    }
    response.writeHead(200, {
      ...HEADERS,
      'content-type': 'text/event-stream',
    });
    if (behavior === 'slow') return;
    const first = chunk(CONTRACT_TEXT[0]);
    if (behavior === 'error-before-text') response.end(sse(UPSTREAM_ERROR));
    else if (behavior === 'error-after-text')
      response.end(first + sse(UPSTREAM_ERROR));
    else if (behavior === 'truncated-after-text') response.end(first);
    else if (behavior === 'malformed-before-text')
      response.end(`data: {${UPSTREAM_MARKER}\n\n`);
    else if (behavior === 'oversize')
      response.end(chunk(UPSTREAM_MARKER.repeat(64 * 1024)));
    else response.end(COMPLETE);
  };
}

export const listing =
  (ids: readonly string[] = [FAKE_OPENAI_MODEL]) =>
  (response: ServerResponse) => {
    response
      .writeHead(200, HEADERS)
      .end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }));
  };

// Serves the routes on an ephemeral loopback port; close() destroys open sockets so stalls never leak.
export async function startFakeOpenAi(
  completion: Completion,
  models: (response: ServerResponse) => void = listing(),
) {
  const sockets = new Set<Socket>();
  const seen: SeenRequest[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part: string) => {
      body += part;
    });
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });
      if (request.url === '/v1/models') models(response);
      else if (request.url === '/v1/chat/completions') completion(response);
      else response.writeHead(404, HEADERS).end(UPSTREAM_ERROR);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
