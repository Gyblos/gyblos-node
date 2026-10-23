// Loopback HTTP proxy that forwards bounded inference POSTs and their payment header to the seller over
// Iroh, one exchange at a time, and appends per-request route metrics. It never signs payments.
import { appendFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  FILE_MODES,
  HTTP_STATUS,
  LOCALHOST,
  P2P,
  PORTS,
  ROUTES,
  TRANSPORT_LIMITS,
  TRANSPORT_TIMEOUTS,
} from '@gyblos/config';
import { rolePath } from '@gyblos/node/roles';
import { acceptLoopbackHost } from '@gyblos/runtime/loopback-host';
import type { Transport } from '@gyblos/transport-iroh';
import { HTTP_OVER_IROH } from '@gyblos/transport-iroh/constants';

import {
  BUYER_PROXY_ERROR_CODES,
  type BuyerProxyErrorCode,
} from './constants.js';

interface ProxyError {
  code: BuyerProxyErrorCode;
  error: string;
}

function rejectMalformedJson(response: ServerResponse) {
  const error: ProxyError = {
    code: BUYER_PROXY_ERROR_CODES.MALFORMED_JSON,
    error: 'Malformed JSON request',
  };
  response
    .writeHead(HTTP_STATUS.badRequest, { 'content-type': 'application/json' })
    .end(JSON.stringify(error));
}

export function buyerProxyHandler(transport: Transport) {
  let active = 0;
  let previous = Promise.resolve();
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!acceptLoopbackHost(request, response)) return;
    if (request.method !== 'POST' || request.url !== ROUTES.inference) {
      response.writeHead(HTTP_STATUS.badRequest).end();
      return;
    }
    if (active >= TRANSPORT_LIMITS.maxConcurrent) {
      response.writeHead(HTTP_STATUS.tooManyRequests).end();
      return;
    }
    active++;
    let release: (() => void) | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > HTTP_OVER_IROH.bodyBytes)
          throw new Error('Request body exceeds limit.');
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        host: `${LOCALHOST}:${PORTS.buyerProxy}`,
      };
      const payment = request.headers['payment-signature'];
      if (typeof payment === 'string') headers['payment-signature'] = payment;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        rejectMalformedJson(response);
        return;
      }
      const identifier = (parsed as { requestId?: unknown }).requestId;
      const pending = previous;
      previous = new Promise<void>((resolve) => {
        release = resolve;
      });
      await pending;
      if (response.destroyed || request.aborted) return;
      const result = await transport.exchange({
        method: 'POST',
        path: ROUTES.inference,
        headers,
        body,
      });
      const metric = {
        requestId: typeof identifier === 'string' ? identifier : null,
        status: result.status,
        transport: result.transport,
        connectMs: result.connectMs,
        directObserved: result.directObserved,
        relayObserved: result.relayObserved,
      };
      await appendFile(
        rolePath(P2P.metricsFilename),
        JSON.stringify(metric) + '\n',
        { mode: FILE_MODES.privateFile },
      ).catch(() => undefined); // Telemetry must not replace a settled response.
      response.writeHead(result.status, result.headers);
      response.end(Buffer.from(result.body));
    } catch {
      response
        .writeHead(HTTP_STATUS.serviceUnavailable, {
          'content-type': 'application/json',
        })
        .end(
          '{"error":"Transport outcome uncertain; reconcile before another payment"}',
        );
    } finally {
      release?.();
      active--;
    }
  };
}

export async function startBuyerProxy(transport: Transport) {
  const server = createServer(
    {
      maxHeaderSize: HTTP_OVER_IROH.headerBytes,
      requestTimeout: TRANSPORT_TIMEOUTS.requestMs,
    },
    buyerProxyHandler(transport),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORTS.buyerProxy, LOCALHOST, () => resolve());
  });
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await transport.close();
    },
  };
}
