import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { Endpoint, RelayMode } from '@number0/iroh';

import { IPV6_LOOPBACK, LOCALHOST, P2P, ROUTES } from '@gyblos/config';
import { createIrohTransport } from '@gyblos/transport/iroh-client';
import { serveIroh } from '@gyblos/transport/iroh-server';

async function endpoint() {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.disabled());
  builder.bindAddr(`${LOCALHOST}:0`);
  builder.bindAddr(`${IPV6_LOOPBACK}:0`);
  builder.alpns([[...Buffer.from(P2P.protocol)]]);
  return builder.bind();
}

async function exercise(relayOnly: boolean, wrongIdentity: boolean) {
  const seller = await endpoint(),
    buyer = await endpoint();
  let executions = 0;
  const http = createServer((request, response) => {
    executions++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, ROUTES.inference);
    response.writeHead(402, {
      'content-type': 'application/json',
      'payment-required': 'synthetic-challenge',
    });
    response.end('{"synthetic":true}');
  });
  http.listen(0, LOCALHOST);
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const bridge = serveIroh(
      seller,
      `http://${LOCALHOST}:${address.port}`,
      relayOnly,
    ),
    transport = createIrohTransport(
      buyer,
      seller.addr(),
      wrongIdentity ? buyer.id().toString() : seller.id().toString(),
    );
  try {
    if (wrongIdentity) {
      await assert.rejects(transport.ready(), /NodeId/);
      assert.equal(executions, 0);
      return;
    }
    const invoke = () =>
      transport.exchange({
        method: 'POST',
        path: ROUTES.inference,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"requestId":"synthetic"}'),
      });
    if (relayOnly) {
      await assert.rejects(invoke());
      assert.equal(executions, 0);
    } else {
      const result = await invoke();
      assert.equal(result.status, 402);
      assert.equal(result.headers['payment-required'], 'synthetic-challenge');
      assert.equal(Buffer.from(result.body).toString(), '{"synthetic":true}');
      assert.equal(result.transport, 'iroh-direct');
      assert.equal(executions, 1);
    }
  } finally {
    await transport.close();
    await bridge.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

test('native Iroh carries HTTP payment challenges without public HTTP ports', () =>
  exercise(false, false));
test('native remote NodeId mismatch blocks HTTP before any signing challenge', () =>
  exercise(false, true));
test('relay-only server refuses an observed direct path before forwarding HTTP', () =>
  exercise(true, false));
