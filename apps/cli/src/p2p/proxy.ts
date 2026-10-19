import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import {
  FILE_MODES,
  HTTP_STATUS,
  LOCALHOST,
  P2P,
  ROUTES,
} from '@gyblos/config';
import type { Transport } from '@gyblos/transport';

import { rolePath } from './roles.js';

export async function startBuyerProxy(transport: Transport) {
  let active = 0;
  const server = createServer(
    { maxHeaderSize: P2P.headerBytes, requestTimeout: P2P.requestMs },
    async (request, response) => {
      if (request.method !== 'POST' || request.url !== ROUTES.inference) {
        response.writeHead(HTTP_STATUS.badRequest).end();
        return;
      }
      if (active >= P2P.maxConcurrent) {
        response.writeHead(HTTP_STATUS.tooManyRequests).end();
        return;
      }
      active++;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > P2P.bodyBytes)
            throw new Error('Request body exceeds limit.');
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks),
          headers: Record<string, string> = {
            'content-type': 'application/json',
            host: `${LOCALHOST}:${P2P.buyerProxyPort}`,
          };
        const payment = request.headers['payment-signature'];
        if (typeof payment === 'string') headers['payment-signature'] = payment;
        const result = await transport.exchange({
          method: 'POST',
          path: ROUTES.inference,
          headers,
          body,
        });
        const identifier = (
          JSON.parse(body.toString('utf8')) as { requestId?: unknown }
        ).requestId;
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
        );
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
        active--;
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(P2P.buyerProxyPort, LOCALHOST, () => resolve());
  });
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await transport.close();
    },
  };
}
