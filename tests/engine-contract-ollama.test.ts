// Runs the shared Engine contract against engine-ollama with a synthetic loopback Ollama server.
// No model, tokenizer or network beyond 127.0.0.1 is used.
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { ROUTES } from '@gyblos/config';
import { MODEL, MODEL_LIMITS } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

import {
  CONTRACT_TEXT,
  engineContract,
  UPSTREAM_MARKER,
  type EngineBehavior,
} from './support/engine-contract';

const HEADERS = { 'x-upstream': UPSTREAM_MARKER };
const STATUSES: Partial<Record<EngineBehavior, number>> = {
  'status-401': 401,
  'status-402': 402,
  'status-429': 429,
  'status-500': 500,
};

function frame(text: string, done = false) {
  return (
    JSON.stringify({
      model: MODEL.name,
      response: text,
      done,
      ...(done
        ? {
            done_reason: ENGINE_DONE_REASONS.STOP,
            prompt_eval_count: 1,
            eval_count: 2,
            total_duration: 3,
            load_duration: 0,
            prompt_eval_duration: 1,
            eval_duration: 2,
          }
        : {}),
    }) + '\n'
  );
}
const complete = frame(CONTRACT_TEXT[0]) + frame(CONTRACT_TEXT[1], true);
const upstreamError = JSON.stringify({ error: UPSTREAM_MARKER }) + '\n';

function generation(behavior: EngineBehavior, response: ServerResponse) {
  const status = STATUSES[behavior];
  if (status !== undefined) {
    response.writeHead(status, HEADERS).end(upstreamError);
    return;
  }
  response.writeHead(200, {
    ...HEADERS,
    'content-type': 'application/x-ndjson',
  });
  if (behavior === 'slow') return;
  if (behavior === 'error-before-text') response.end(upstreamError);
  else if (behavior === 'error-after-text')
    response.end(frame(CONTRACT_TEXT[0]) + upstreamError);
  else if (behavior === 'truncated-after-text')
    response.end(frame(CONTRACT_TEXT[0]));
  else if (behavior === 'malformed-before-text')
    response.end(`{${UPSTREAM_MARKER}\n`);
  else if (behavior === 'oversize')
    response.end(
      frame(UPSTREAM_MARKER.repeat(MODEL_LIMITS.maxOutputCharacters)),
    );
  else response.end(complete);
}

engineContract('engine-ollama', {
  async start(behavior, options) {
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      if (request.url === ROUTES.ollamaTags) {
        response.writeHead(200, HEADERS).end(
          JSON.stringify({
            models:
              behavior === 'model-missing'
                ? [{ name: UPSTREAM_MARKER, digest: MODEL.digest }]
                : [{ name: MODEL.name, digest: MODEL.digest }],
          }),
        );
        return;
      }
      request.resume();
      generation(behavior, response);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const close = () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
    if (behavior === 'refused') await close();
    return {
      engine: createOllamaEngine(`http://127.0.0.1:${port}/`, fetch, options),
      close: behavior === 'refused' ? async () => {} : close,
    };
  },
});
