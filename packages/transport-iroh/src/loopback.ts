// Forwards one bridged inference POST to the seller's literal loopback origin with bounded response size.
import { LOCALHOST, ROUTES, TRANSPORT_TIMEOUTS } from '@gyblos/config';

import { HTTP_OVER_IROH } from './constants.js';
import type { HttpRequest, HttpResponse } from './types.js';

export async function loopbackRequest(
  origin: string,
  request: HttpRequest,
  signal?: AbortSignal,
): Promise<HttpResponse> {
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOCALHOST ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Loopback origin required.');
  if (
    request.method !== 'POST' ||
    request.path !== ROUTES.inference ||
    request.body.length > HTTP_OVER_IROH.bodyBytes
  )
    throw new Error('Inference route required.');
  const response = await fetch(new URL(ROUTES.inference, url), {
    method: 'POST',
    headers: request.headers,
    body: Buffer.from(request.body),
    redirect: 'error',
    signal: AbortSignal.any([
      AbortSignal.timeout(TRANSPORT_TIMEOUTS.requestMs),
      ...(signal ? [signal] : []),
    ]),
  });
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    if (reader)
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > HTTP_OVER_IROH.responseBytes)
          throw new Error('Response exceeds limit.');
        parts.push(part.value);
      }
  } finally {
    await reader?.cancel().catch(() => {});
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    status: response.status,
    headers,
    body: Buffer.concat(parts),
  };
}
