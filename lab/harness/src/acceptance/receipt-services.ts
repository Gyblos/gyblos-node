// Routes startup fetches only to the owned index, fake provider and exact local read-only registry.
import { fetchSellers } from '@gyblos/discovery-http';

import { ACCEPTANCE } from './constants';
import { createAcceptanceIndex } from './index';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';
import { receiptNativeBinding } from './receipt-native';
import { createReceiptProvider } from './receipt-provider';

export function createReceiptServices(
  nodeId: string,
  signal: AbortSignal,
  registryUrl: string,
  provider = createReceiptProvider(),
) {
  const localFetch = globalThis.fetch;
  const binding = receiptNativeBinding(provider);
  const index = createAcceptanceIndex(Date.now, nodeId);
  let externalCalls = 0;
  let discoveryReads = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === RECEIPT_ACCEPTANCE.engineOrigin)
      return provider.request(request);
    if (url.origin === ACCEPTANCE.origin && url.pathname.startsWith('/v1/')) {
      if (request.method === 'GET') discoveryReads++;
      return index.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...(request.method === 'GET' ? {} : { body: await request.text() }),
      });
    }
    if (request.url === registryUrl + '/' && request.method === 'POST')
      return localFetch(request);
    externalCalls++;
    throw new Error('Forbidden external I/O');
  };
  const listed = () =>
    fetchSellers({
      baseUrl: index.baseUrl,
      model: RECEIPT_ACCEPTANCE.modelId,
      fetch: index.fetch,
      now: Date.now,
      signal,
    });
  return {
    provider,
    binding,
    index,
    listed,
    externalCalls: () => externalCalls,
    discoveryReads: () => discoveryReads,
  };
}
export type ReceiptServices = ReturnType<typeof createReceiptServices>;
