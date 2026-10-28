// A synthetic Anthropic-compatible server on loopback: `GET /v1/models/{id}` and streaming
// `POST /v1/messages` with every Engine contract behavior, recording what each request carried. Test
// data only; no real provider, key or model.
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import {
  CONTRACT_TEXT,
  UPSTREAM_MARKER,
  type EngineBehavior,
} from './engine-contract';

export const FAKE_ANTHROPIC_MODEL = 'acme-chat-large';
export const HEADERS = { 'x-upstream': UPSTREAM_MARKER };
const STATUSES: Partial<Record<EngineBehavior, number>> = {
  'status-401': 401,
  'status-402': 402,
  'status-429': 429,
  'status-500': 500,
  'model-missing': 404,
};
export const errorBody = (type: string) =>
  JSON.stringify({ type: 'error', error: { type, message: UPSTREAM_MARKER } });

export const event = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
export const start = (input = 3, extra: Record<string, unknown> = {}) =>
  event('message_start', {
    message: {
      id: 'msg_synthetic',
      type: 'message',
      role: 'assistant',
      model: FAKE_ANTHROPIC_MODEL,
      content: [],
      stop_reason: null,
      usage: { input_tokens: input, output_tokens: 1, ...extra },
    },
  });
export const block = (type = 'text', index = 0) =>
  event('content_block_start', {
    index,
    content_block: type === 'text' ? { type, text: '' } : { type },
  });
export const text = (value: string, index = 0) =>
  event('content_block_delta', {
    index,
    delta: { type: 'text_delta', text: value },
  });
export const thinking = (value: string, index = 0) =>
  event('content_block_delta', {
    index,
    delta: { type: 'thinking_delta', thinking: value },
  });
export const blockStop = (index = 0) => event('content_block_stop', { index });
export const end = (reason = 'end_turn', output = 2) =>
  event('message_delta', {
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: output },
  });
export const STOP = event('message_stop');
export const PING = event('ping');
export const COMPLETE =
  start() +
  block() +
  PING +
  CONTRACT_TEXT.map((value) => text(value)).join('') +
  blockStop() +
  end() +
  STOP;

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type Messages = (response: ServerResponse) => void;

export function contractMessages(behavior: EngineBehavior): Messages {
  return (response) => {
    const status = STATUSES[behavior];
    if (status !== undefined) {
      response.writeHead(status, HEADERS).end(errorBody('api_error'));
      return;
    }
    response.writeHead(200, {
      ...HEADERS,
      'content-type': 'text/event-stream',
    });
    if (behavior === 'slow') return;
    const first = start() + block() + text(CONTRACT_TEXT[0]);
    const failed = event('error', {
      error: { type: 'overloaded_error', message: UPSTREAM_MARKER },
    });
    if (behavior === 'error-before-text') response.end(start() + failed);
    else if (behavior === 'error-after-text') response.end(first + failed);
    else if (behavior === 'truncated-after-text') response.end(first);
    else if (behavior === 'malformed-before-text')
      response.end(`event: message_start\ndata: {${UPSTREAM_MARKER}\n\n`);
    else if (behavior === 'oversize')
      response.end(start() + block() + text(UPSTREAM_MARKER.repeat(64 * 1024)));
    else response.end(COMPLETE);
  };
}

export const modelFound = (response: ServerResponse) => {
  response.writeHead(200, HEADERS).end(
    JSON.stringify({
      type: 'model',
      id: FAKE_ANTHROPIC_MODEL,
      display_name: 'Synthetic',
    }),
  );
};

// Serves the routes on an ephemeral loopback port; close() destroys open sockets so stalls never leak.
export async function startFakeAnthropic(
  messages: Messages,
  model: (response: ServerResponse) => void = modelFound,
) {
  const sockets = new Set<Socket>();
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (part: string) => {
      body += part;
    });
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      if (request.url === '/v1/messages') messages(response);
      else if (request.url?.startsWith('/v1/models/')) model(response);
      else response.writeHead(404, HEADERS).end(errorBody('not_found_error'));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
