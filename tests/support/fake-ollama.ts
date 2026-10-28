// A synthetic Ollama on 127.0.0.1 with an ephemeral port: lists the pinned model (or never answers, to
// exercise deadlines) and answers every generation with one short complete frame. Records request paths;
// no model or network beyond loopback.
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { ROUTES } from '@gyblos/config';
import { MODEL } from '@gyblos/engine-ollama/constants';

export interface FakeOllama {
  // The engine URL to put in gyblos.toml, e.g. http://127.0.0.1:54321
  url: string;
  paths: string[];
  close: () => Promise<void>;
}

const DONE = {
  model: MODEL.name,
  response: 'OK',
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 1,
  eval_count: 1,
  total_duration: 1,
  load_duration: 0,
  prompt_eval_duration: 0,
  eval_duration: 1,
};

function json(response: ServerResponse, body: unknown) {
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify(body));
}

export async function startFakeOllama(
  options: { hang?: boolean } = {},
): Promise<FakeOllama> {
  const paths: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    request.resume();
    if (options.hang) return;
    if (request.url === ROUTES.ollamaTags)
      return json(response, {
        models: [{ name: MODEL.name, digest: MODEL.digest }],
      });
    if (request.url === ROUTES.ollamaGenerate) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return response.end(JSON.stringify(DONE) + '\n');
    }
    response.writeHead(404).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
