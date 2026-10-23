// Checks HTTP payment traffic over native Iroh: NodeId mismatch and direct-path refusal before signing,
// free-request quota across reconnects, plus the egress and native transport suites.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { HTTP_STATUS, LOCALHOST, P2P, ROUTES } from '@gyblos/config';
import { createIrohTransport } from '@gyblos/transport-iroh/iroh-client';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { registerEgressCases } from './support/egress-cases.js';
import { registerNativeCases } from './support/native-cases.js';
import { endpoint, fixture, fixtureRequest } from './support/native-fixture.js';
import { NATIVE_TEST_OPTIONS, waitFor } from './support/native-runtime.js';

async function exercise(relayOnly: boolean, wrongIdentity: boolean) {
  const seller = await endpoint();
  const buyer = await endpoint();
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
  );
  const transport = createIrohTransport(
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

void test(
  'native Iroh carries HTTP payment challenges without public HTTP ports',
  NATIVE_TEST_OPTIONS,
  () => exercise(false, false),
);
void test(
  'native remote NodeId mismatch blocks HTTP before any signing challenge',
  NATIVE_TEST_OPTIONS,
  () => exercise(false, true),
);
void test(
  'relay-only server refuses an observed direct path before forwarding HTTP',
  NATIVE_TEST_OPTIONS,
  () => exercise(true, false),
);

registerNativeCases();
registerEgressCases();

void test(
  'native smoke: nine distinct free-request peers disconnect and a newcomer remains admissible',
  { ...NATIVE_TEST_OPTIONS, timeout: 20000 },
  async () => {
    const lab = await fixture();
    const identities = new Set<string>();
    try {
      for (let index = 0; index < 9; index++) {
        const peer = await lab.transport();
        const id = lab.nodeId(peer);
        assert.ok(id);
        assert.equal(identities.has(id), false);
        identities.add(id);
        assert.equal(
          (await peer.exchange(fixtureRequest('free-' + index))).status,
          402,
        );
        await peer.close();
        await waitFor(
          () => lab.retired.has(id),
          undefined,
          'server retirement of disconnected peer',
        );
      }
      const newcomer = await lab.transport();
      for (let index = 0; index < P2P.requestsPerWindow; index++)
        assert.equal(
          (await newcomer.exchange(fixtureRequest('newcomer-' + index))).status,
          HTTP_STATUS.paymentRequired,
        );
      assert.equal(
        (await newcomer.exchange(fixtureRequest('newcomer-over-budget')))
          .status,
        HTTP_STATUS.tooManyRequests,
      );
      assert.equal(lab.accepted.length, 9 + P2P.requestsPerWindow);
      assert.equal(lab.executions, 0);
      assert.equal(lab.paid.size, 0);
    } finally {
      await lab.close();
    }
  },
);

void test(
  'native same-NodeId reconnect preserves remaining quota and refuses after actual consumption',
  { ...NATIVE_TEST_OPTIONS, timeout: 20000 },
  async () => {
    const lab = await fixture();
    const secret = [...randomBytes(P2P.nodeSecretBytes)];
    try {
      const first = await lab.transport(secret);
      const identity = lab.nodeId(first);
      for (let index = 0; index < 4; index++)
        assert.equal(
          (await first.exchange(fixtureRequest('before-' + index))).status,
          402,
        );
      await first.close();
      assert.ok(identity);
      await waitFor(
        () => lab.retired.has(identity),
        undefined,
        'server retirement before same-identity reconnect',
      );
      const returning = await lab.transport(secret);
      assert.equal(lab.nodeId(returning), identity);
      for (let index = 4; index < P2P.requestsPerWindow; index++)
        assert.equal(
          (await returning.exchange(fixtureRequest('after-' + index))).status,
          402,
        );
      assert.equal(
        (await returning.exchange(fixtureRequest('over-budget'))).status,
        HTTP_STATUS.tooManyRequests,
      );
      assert.equal(lab.accepted.length, P2P.requestsPerWindow);
      assert.equal(lab.executions, 0);
      assert.equal(lab.paid.size, 0);
    } finally {
      await lab.close();
    }
  },
);
