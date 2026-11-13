// Serves a non-authoritative local return page; approval is always checked with PayPal.
import { createServer } from 'node:http';

import { HTTP_STATUS, LOCALHOST } from '@gyblos/config';
import {
  isPaypalId,
  isPaypalReturnState,
} from '@gyblos/protocol/paypal-payment';

export async function openDesktopPaypalCallback(
  onApproved?: (value: { state: string; token?: string }) => void,
  onCancelled?: (value: { state: string; token?: string }) => void,
) {
  let origin = '';
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (closing) {
      response.writeHead(HTTP_STATUS.serviceUnavailable).end();
      return;
    }
    if (!origin || request.headers.host !== new URL(origin).host) {
      response.writeHead(HTTP_STATUS.forbidden).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', origin);
    } catch {
      response.writeHead(HTTP_STATUS.badRequest).end();
      return;
    }
    const path = url.pathname;
    if (
      request.method !== 'GET' ||
      (path !== '/paypal/approved' && path !== '/paypal/cancelled')
    ) {
      response.writeHead(HTTP_STATUS.notFound).end();
      return;
    }
    if (url.origin === origin) {
      const states = url.searchParams.getAll('state');
      const tokens = url.searchParams.getAll('token');
      const state = states[0];
      const token = tokens[0];
      if (
        states.length === 1 &&
        isPaypalReturnState(state) &&
        tokens.length <= 1 &&
        (token === undefined || isPaypalId(token))
      ) {
        try {
          const notify = path === '/paypal/approved' ? onApproved : onCancelled;
          notify?.({ state, ...(token === undefined ? {} : { token }) });
        } catch {
          // The return page is non-authoritative; the app retains manual recovery.
        }
      }
    }
    response.writeHead(HTTP_STATUS.ok, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
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
    close: () => {
      if (!closing) {
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
