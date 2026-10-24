// Serves the real discovery app on ephemeral HTTP loopback, with memory storage and synthetic limiters.
// No deployment, credentials, remote service or operational local home is involved.
import { once } from 'node:events';
import { createServer } from 'node:http';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';

export async function publicationIndex(now: () => number) {
  const storage = createMemoryStorage();
  const app = createDiscoveryIndex({ storage, now, development: true });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (value)
          headers.set(name, Array.isArray(value) ? value.join(',') : value);
      const body = Buffer.concat(chunks).toString('utf8');
      const result = await app.request(
        new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers,
          body: body || undefined,
        }),
      );
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.writeHead(result.status);
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic loopback bind failed.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    storage,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
