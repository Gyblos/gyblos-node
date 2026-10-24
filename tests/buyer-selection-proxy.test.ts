// Exercises real loopback proxy routing with signed synthetic quotes and fake authorization headers.
// Transport calls only return synthetic v1 challenges/results; no payment code is executed.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import { buyerProxyHandler } from '@gyblos/buyer/proxy';
import { selectBuyerQuote } from '@gyblos/buyer/selection';
import {
  createProxySelection,
  type ProxySelection,
} from '@gyblos/buyer/selection-proxy';
import { homeLayout, ROUTES } from '@gyblos/config';
import type { Transport } from '@gyblos/transport-iroh';
import { TRANSPORT_ROUTES } from '@gyblos/transport-iroh/constants';

import { selectionFixture } from './support/buyer-selection.js';

async function proxy(
  selection: ProxySelection,
  exchange: Transport['exchange'],
) {
  const directory = await mkdtemp(join(tmpdir(), 'selection-proxy-'));
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = directory;
  await mkdir(homeLayout(process.env).roles.buyer, { recursive: true });
  const server = createServer(
    buyerProxyHandler({ kind: 'iroh', exchange, async close() {} }, selection),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    send(authorized = false, prompt = 'synthetic', requestId = 'one') {
      return fetch(`http://127.0.0.1:${address.port}${ROUTES.inference}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorized
            ? { 'payment-signature': 'synthetic-not-an-authorization' }
            : {}),
        },
        body: JSON.stringify({ requestId, prompt, maxTokens: 100 }),
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.GYBLOS_HOME;
      else process.env.GYBLOS_HOME = previous;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const reply = (status: number) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{}'),
  transport: TRANSPORT_ROUTES.DIRECT,
  connectMs: 0,
  directObserved: true,
  relayObserved: false,
});
void test('loopback select → signed quote → non-trusted stop forwards neither inference nor authorization', async () => {
  const run = await selectionFixture();
  let forwards = 0;
  const guard = createProxySelection(
    (signal) =>
      selectBuyerQuote(
        run.config,
        {
          ...run.dependencies,
          trusted: { nodeId: '0'.repeat(64), owner: run.catalog.owner },
        },
        signal,
      ),
    100,
    run.context.now,
  );
  const host = await proxy(guard, async () => {
    forwards++;
    return reply(200);
  });
  try {
    const response = await host.send();
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: BUYER_SELECTION_CODES.QUOTE_ONLY,
    });
    assert.equal((await host.send(true)).status, 409);
    assert.equal(forwards, 0);
    assert.equal(run.wire.queries, 3);
  } finally {
    await host.close();
    await run.wire.close();
  }
});
void test('loopback trusted winner keeps v1 bytes and headers unchanged and authorizes at most once', async () => {
  const run = await selectionFixture();
  const forwards: string[] = [];
  const guard = createProxySelection(
    (signal) => selectBuyerQuote(run.config, run.dependencies, signal),
    100,
    run.context.now,
  );
  const host = await proxy(guard, async (request) => {
    forwards.push(Buffer.from(request.body).toString());
    return reply(request.headers['payment-signature'] ? 200 : 402);
  });
  try {
    assert.equal((await host.send()).status, 402);
    assert.equal((await host.send(true)).status, 200);
    assert.deepEqual(forwards, [forwards[0], forwards[0]]);
    assert.equal((await host.send(true)).status, 409);
    assert.equal(forwards.length, 2);
    assert.equal(run.wire.queries, 3);
  } finally {
    await host.close();
    await run.wire.close();
  }
});
void test('changed-body authorization is refused without re-selection or forwarding', async () => {
  const run = await selectionFixture();
  let forwards = 0;
  const guard = createProxySelection(
    (signal) => selectBuyerQuote(run.config, run.dependencies, signal),
    100,
    run.context.now,
  );
  const host = await proxy(guard, async () => {
    forwards++;
    return reply(402);
  });
  try {
    await host.send();
    assert.equal((await host.send(true, 'changed')).status, 409);
    assert.equal(forwards, 1);
    assert.equal(run.wire.queries, 3);
  } finally {
    await host.close();
    await run.wire.close();
  }
});
void test('lost authorized response poisons subsequent routing and never retries or selects another seller', async () => {
  const run = await selectionFixture();
  let forwards = 0;
  const guard = createProxySelection(
    (signal) => selectBuyerQuote(run.config, run.dependencies, signal),
    100,
    run.context.now,
  );
  const host = await proxy(guard, async (request) => {
    forwards++;
    if (request.headers['payment-signature'])
      throw new Error('Synthetic lost response');
    return reply(402);
  });
  try {
    assert.equal((await host.send()).status, 402);
    assert.equal((await host.send(true)).status, 503);
    const response = await host.send(false, 'synthetic', 'different');
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: BUYER_SELECTION_CODES.RECONCILE,
    });
    assert.equal(forwards, 2);
    assert.equal(run.wire.queries, 3);
  } finally {
    await host.close();
    await run.wire.close();
  }
});
