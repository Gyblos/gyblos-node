// Verifies the free client's existing request budget during authentication without native connections.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EndpointAddr, EndpointId } from '@number0/iroh';

import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';

import { freeSellerFixture } from './support/free-seller';

async function fixture() {
  const source = await freeSellerFixture();
  const request = await source.request();
  const buyer = EndpointId.fromBytes([
    ...Buffer.from(request.quote.offer.buyerNodeId, 'hex'),
  ]);
  let dials = 0;
  const endpoint = {
    id: () => buyer,
    connect: async () => {
      dials++;
      throw new Error('Authentication must finish before connecting');
    },
  };
  const remote = new EndpointAddr(
    EndpointId.fromBytes([...Buffer.from(source.options.nodeId, 'hex')]),
  );
  const client = createFreeExecutionClient(
    endpoint,
    remote,
    { owner: source.options.owner, nodeId: source.options.nodeId },
    { now: source.options.now, requestMs: 100 },
  );
  return { request, client, dials: () => dials };
}

void test('free client keeps the request deadline while authentication is pending', async (context) => {
  const item = await fixture();
  const original = crypto.subtle.verify;
  const verify = original.bind(crypto.subtle);
  let entered = () => {};
  const authenticating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  crypto.subtle.verify = async (...args) => {
    entered();
    await held;
    return verify(...args);
  };
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let completed = false;
  const operation = item.client.execute(item.request);
  const observed = operation.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  const rejected = assert.rejects(operation, {
    code: FREE_EXECUTION_CODES.TIMEOUT,
    remote: false,
    sent: false,
  });
  try {
    await Promise.race([authenticating, operation]);
    context.mock.timers.tick(99);
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(item.dials(), 0);
    context.mock.timers.tick(1);
    await rejected;
    assert.equal(item.dials(), 0);
  } finally {
    crypto.subtle.verify = original;
    release();
    item.client.close();
    await item.client.settled();
    await observed;
    await rejected.catch(() => undefined);
  }
});
