// Serves a non-authoritative local return page; approval is always checked with PayPal.
import { createServer } from 'node:http';

import { HTTP_STATUS, LOCALHOST } from '@gyblos/config';

export async function openDesktopPaypalCallback() {
  let origin = '';
  const server = createServer((request, response) => {
    if (!origin || request.headers.host !== new URL(origin).host) {
      response.writeHead(HTTP_STATUS.forbidden).end();
      return;
    }
    const path = request.url?.split('?')[0];
    if (
      request.method !== 'GET' ||
      (path !== '/paypal/approved' && path !== '/paypal/cancelled')
    ) {
      response.writeHead(HTTP_STATUS.notFound).end();
      return;
    }
    response.writeHead(HTTP_STATUS.ok, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
    });
    response.end('Return to Gyblos to continue.');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCALHOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Invalid callback listener.');
  }
  origin = `http://${LOCALHOST}:${address.port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
