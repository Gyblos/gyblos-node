// Holds a synthetic loopback registry while forcing collection; no endpoint, key, wallet or chain is created.
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { setImmediate } from 'node:timers/promises';

import { LOCALHOST } from '@gyblos/config';
import { createReceiptServices } from '@gyblos/lab-harness/acceptance/receipt-services';

import { batchDeferred } from './batch-deferred';
import { within } from './test-deadline';

const collect = globalThis.gc;
assert.ok(collect, 'The isolated registry probe requires --expose-gc');
for (const requestInput of [false, true]) {
  const received = batchDeferred<void>();
  let response: ServerResponse | undefined;
  let body = '';
  const server = createServer((incoming, outgoing) => {
    response = outgoing;
    incoming.setEncoding('utf8');
    incoming.on('data', (part: string) => {
      body += part;
    });
    incoming.once('end', () => received.resolve());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCALHOST, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const registry = `http://${LOCALHOST}:${address.port}`;
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const services = createReceiptServices(
    '00'.repeat(32),
    controller.signal,
    registry,
  );
  try {
    await assert.rejects(fetch(registry + '/forbidden', { method: 'POST' }));
    assert.equal(services.externalCalls(), 1);
    const options = { method: 'POST', body: '{}', signal: controller.signal };
    const input = requestInput
      ? new Request(registry + '/', options)
      : registry + '/';
    const pending = fetch(input, requestInput ? undefined : options);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    void rejected.catch(() => {});
    await within(received.promise, 1000);
    assert.equal(body, '{}');
    for (let round = 0; round < 5; round++) {
      await setImmediate();
      collect();
    }
    await setImmediate();
    controller.abort();
    await within(rejected, 1000);
    // Retain the caller-owned Request; only the fence's extra Request may be collected.
    if (input instanceof Request) assert.equal(input.signal.aborted, true);
  } finally {
    controller.abort();
    globalThis.fetch = originalFetch;
    response?.end('{}');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await services.binding.close();
  }
}
console.log('ok');
