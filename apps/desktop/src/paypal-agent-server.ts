// Runs a loopback-only OpenAI-compatible sandbox endpoint for the desktop's single PayPal session.
// The generated access key stays local and is independent of PayPal and wallet credentials.
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { HTTP_STATUS, LOCALHOST, ROUTES } from '@gyblos/config';
import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';

import { DESKTOP_PAYPAL_AGENT } from './paypal-agent-model';
import type { createDesktopPaypalSession } from './paypal-session';

type Service = ReturnType<typeof createDesktopPaypalSession>;
type Gateway = ReturnType<typeof createPaypalAgentGateway>;

function requestHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value))
      for (const part of value) headers.append(key, part);
  }
  return headers;
}

function requestBody(request: IncomingMessage) {
  const iterator = request[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const part = await iterator.next();
          if (part.done) controller.close();
          else if (part.value instanceof Uint8Array)
            controller.enqueue(part.value);
          else if (typeof part.value === 'string')
            controller.enqueue(new TextEncoder().encode(part.value));
          else controller.error(new Error('Invalid request body.'));
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        request.destroy();
      },
    },
    { highWaterMark: 0 },
  );
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  gateway: Gateway,
) {
  const abort = new AbortController();
  request.once('aborted', () => abort.abort());
  response.once('close', () => {
    if (!response.writableEnded) abort.abort();
  });
  try {
    const method = request.method ?? 'GET';
    const init: RequestInit & { duplex: 'half' } = {
      method,
      headers: requestHeaders(request),
      signal: abort.signal,
      duplex: 'half',
      ...(method === 'POST' ? { body: requestBody(request) } : {}),
    };
    const incoming = new Request(new URL(request.url ?? '/', origin), init);
    const result = await gateway.handle(incoming);
    if (response.destroyed) return;
    if (!request.complete) response.shouldKeepAlive = false;
    const headers: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      headers[key] = value;
    });
    response.writeHead(result.status, headers);
    response.end(await result.text());
  } catch {
    if (!response.destroyed && !response.writableEnded) {
      response.shouldKeepAlive = false;
      response.writeHead(HTTP_STATUS.internalServerError).end();
    }
  }
}

export async function startDesktopPaypalAgent(service: Service, model: string) {
  let origin = '';
  let gateway: Gateway | undefined;
  const server = createServer((request, response) => {
    if (!gateway)
      return response.writeHead(HTTP_STATUS.serviceUnavailable).end();
    void dispatch(request, response, origin, gateway);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCALHOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Local agent endpoint is unavailable.');
  }
  origin = `http://${LOCALHOST}:${address.port}`;
  const key = randomBytes(DESKTOP_PAYPAL_AGENT.TOKEN_BYTES).toString('base64url');
  gateway = createPaypalAgentGateway({ origin, key, model, service });
  return {
    url: `${origin}${ROUTES.agentBase}`,
    key,
    model,
    hasPending: gateway.hasPending,
    acknowledgePending: gateway.acknowledgePending,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
