// Actual in-memory discovery handler behind an owned loopback HTTP server; no deployed index access.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { HTTP_STATUS, LOCALHOST } from '@gyblos/config';
import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { PUBLISH_MODES } from '@gyblos/discovery-index/constants';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';

import { HTTP_MULTI } from './http-multiseller-constants';

export async function httpMultiIndex() {
  const nodeIds = new Set<string>();
  const storage = createMemoryStorage();
  const app = createDiscoveryIndex({
    storage,
    now: Date.now,
    development: true,
    publishers: { mode: PUBLISH_MODES.ALLOWLIST, nodeIds },
  });
  let reads = 0;
  let writes = 0;
  let forbidden = 0;
  let origin = '';
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (
        !incoming.url?.startsWith('/v1/') ||
        !['GET', 'POST'].includes(incoming.method ?? '')
      ) {
        forbidden++;
        outgoing.writeHead(HTTP_STATUS.badRequest).end();
        return;
      }
      let body = '';
      let size = 0;
      for await (const chunk of incoming) {
        assert.ok(Buffer.isBuffer(chunk));
        size += chunk.length;
        assert.ok(size <= HTTP_MULTI.maxBytes);
        body += chunk.toString('utf8');
      }
      if (incoming.method === 'GET') reads++;
      else writes++;
      const result = await app.request(
        new Request(origin + incoming.url, {
          method: incoming.method,
          headers: { 'content-type': 'application/json' },
          ...(body ? { body } : {}),
        }),
      );
      result.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.writeHead(result.status);
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => outgoing.writeHead(HTTP_STATUS.badRequest).end());
  });
  server.requestTimeout = HTTP_MULTI.operationMs;
  server.headersTimeout = HTTP_MULTI.operationMs;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCALHOST, resolve);
  });
  const location = server.address();
  assert.ok(location && typeof location !== 'string');
  origin = `http://${LOCALHOST}:${location.port}`;
  return {
    origin,
    baseUrl: origin + '/v1',
    storage,
    allow: (id: string) => nodeIds.add(id),
    counts: () => ({ reads, writes, forbidden }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
