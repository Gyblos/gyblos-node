// Runs a loopback-only OpenAI-compatible sandbox endpoint for the desktop's single PayPal session.
// The generated access key stays local and is independent of PayPal and wallet credentials.
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { HTTP_STATUS, LOCALHOST, ROUTES } from '@gyblos/config';
import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';

import { DESKTOP_AGENT_SERVER_NOT_RUNNING } from './constants';
import { drainAgentResponse } from './paypal-agent-drain';
import { DESKTOP_PAYPAL_AGENT } from './paypal-agent-model';
import type { createDesktopPaypalSession } from './paypal-session';

type Service = ReturnType<typeof createDesktopPaypalSession>;
type Gateway = ReturnType<typeof createPaypalAgentGateway>;

export async function waitForPaypalAgentServerClose(
  close: (done: (error?: Error) => void) => void,
  drain: () => Promise<void>,
) {
  await new Promise<void>((resolve, reject) =>
    close((error) => {
      if (
        error &&
        (!('code' in error) || error.code !== DESKTOP_AGENT_SERVER_NOT_RUNNING)
      )
        reject(error);
      else resolve();
    }),
  );
  await drain();
}

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
    await drainAgentResponse(
      {
        end: (text, done) => {
          response.end(text, done);
        },
        onClosed: (done) => {
          response.once('close', done);
          response.once('error', done);
          return () => {
            response.off('close', done);
            response.off('error', done);
          };
        },
        destroy: () => {
          response.destroy();
        },
      },
      await result.text(),
      DESKTOP_PAYPAL_AGENT.RESPONSE_DRAIN_MS,
    );
  } catch {
    if (!response.destroyed && !response.writableEnded) {
      response.shouldKeepAlive = false;
      response.writeHead(HTTP_STATUS.internalServerError).end();
    }
  }
}

type Lifecycle = {
  closing: boolean;
  inFlight: number;
  drained: (() => void) | undefined;
  shutdown: Promise<void> | undefined;
};
function closeAgentServer(
  server: Server,
  state: Lifecycle,
  revoked: AbortController,
) {
  if (!state.shutdown) {
    state.closing = true;
    revoked.abort();
    const next = waitForPaypalAgentServerClose(
      (done) => {
        server.close(done);
        if (state.inFlight === 0) server.closeAllConnections();
      },
      async () => {
        if (state.inFlight > 0)
          await new Promise<void>((resolve) => {
            state.drained = resolve;
          });
      },
    ).catch((error: unknown) => {
      if (state.shutdown === next) state.shutdown = undefined;
      throw error;
    });
    state.shutdown = next;
  }
  return state.shutdown;
}
export async function startDesktopPaypalAgent(service: Service, model: string) {
  const scope = service.agentScope();
  if (!scope) throw new Error('A fresh agent session is required.');
  const state: Lifecycle = {
    closing: false,
    inFlight: 0,
    drained: undefined,
    shutdown: undefined,
  };
  const revoked = new AbortController();
  const isCurrent = () => !state.closing && service.agentScope() === scope;
  const scopedService = {
    sendAgent: (
      input: unknown,
      signal?: AbortSignal,
      idempotencyKey?: string,
    ) => {
      if (!isCurrent()) throw new Error('Agent access expired.');
      const cancellation = signal
        ? AbortSignal.any([signal, revoked.signal])
        : revoked.signal;
      return service.sendAgent(input, cancellation, idempotencyKey);
    },
  };
  let origin = '';
  let gateway: Gateway | undefined;
  const server = createServer((request, response) => {
    if (!gateway || state.closing || !isCurrent()) {
      response.shouldKeepAlive = false;
      const status =
        !gateway || state.closing
          ? HTTP_STATUS.serviceUnavailable
          : HTTP_STATUS.unauthorized;
      return response.writeHead(status).end();
    }
    state.inFlight += 1;
    void dispatch(request, response, origin, gateway)
      .finally(() => {
        state.inFlight -= 1;
        if (state.closing && state.inFlight === 0) {
          server.closeAllConnections();
          state.drained?.();
        }
      })
      .catch(() => {});
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
  const key = randomBytes(DESKTOP_PAYPAL_AGENT.TOKEN_BYTES).toString(
    'base64url',
  );
  gateway = createPaypalAgentGateway({
    origin,
    key,
    model,
    service: scopedService,
  });
  return {
    url: `${origin}${ROUTES.agentBase}`,
    key,
    model,
    isCurrent,
    isBusy: gateway.isBusy,
    close: () => closeAgentServer(server, state, revoked),
  };
}
