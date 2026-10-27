// A cancelled control dial must remain observable until the native operation settles.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { CONTROL_CODES, FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { createControlTransport } from '@gyblos/transport-iroh/control-client';

import { NATIVE_CAPABILITY } from './support/native-runtime';

void test('control settlement retains a cancelled native dial until its late connection is closed', async () => {
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let release = (_value: Connection) => {};
  let closes = 0;
  const connection = {
    close: () => {
      closes++;
    },
  } as unknown as Connection;
  const endpoint = {
    id: () => ({ toString: () => '1'.repeat(64) }),
    connect: () => {
      began();
      return new Promise<Connection>((resolve) => {
        release = resolve;
      });
    },
  } as unknown as Endpoint;
  const client = createControlTransport(
    endpoint,
    {} as EndpointAddr,
    '2'.repeat(64),
    { queryMs: 1000 },
  );
  const controller = new AbortController();
  const operation = client.exchange({}, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(operation, { code: CONTROL_CODES.CANCELLED });
  let settled = false;
  try {
    const finished = client.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false);
    release(connection);
    await finished;
    assert.equal(closes, 1);
  } finally {
    release(connection);
    await client.close();
  }
});

void test(
  'free orchestration keeps admission while cancelled control SDK work is pending',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { freeBuyerDependencies } =
      await import('@gyblos/buyer/free-selection');
    const { executeBuyerFree } = await import('@gyblos/buyer/free-execution');
    const { FREE_BUYER_CODES } = await import('@gyblos/buyer/constants');
    const { SELLER_BADGES } = await import('@gyblos/core/constants');
    const { controlFixture } = await import('./support/control-fixture');
    const source = await controlFixture(true);
    let began = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let release = (_value: Connection) => {};
    let closes = 0;
    const connection = {
      close: () => {
        closes++;
      },
    } as unknown as Connection;
    const endpoint = {
      id: () => ({ toString: () => source.request.params.buyerNodeId }),
      connect: () => {
        began();
        return new Promise<Connection>((resolve) => {
          release = resolve;
        });
      },
    } as unknown as Endpoint;
    const {
      buyer: _buyer,
      buyerNodeId: _nodeId,
      catalogDigest: _digest,
      ...request
    } = source.request.params;
    const prepared = {
      config: {
        request: {
          ...request,
          maxTokens: 10,
          lowestReasoning: null,
          minimumBadge: SELLER_BADGES.DECLARED_USAGE,
          retention: [source.catalog.dataPolicy.retention],
        },
        sellers: [
          {
            owner: source.catalog.owner,
            nodeId: source.catalog.nodeId,
            relayUrl: null,
            directAddresses: [],
          },
        ],
      },
      stats: {
        rows: new Map<string, LocalSellerStats>(),
        save: async () => {},
      },
      discovery: undefined,
    };
    const dependencies = freeBuyerDependencies(prepared, {
      endpoint,
      buyer: source.request.params.buyer,
      relayOnly: false,
      now: source.context.now,
    });
    const input = {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
      maxTokens: 10,
    };
    const controller = new AbortController();
    let finished = false;
    const operation = executeBuyerFree(
      input,
      dependencies,
      controller.signal,
    ).then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await started;
    controller.abort();
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(finished, false);
      await assert.rejects(executeBuyerFree(input, dependencies), {
        code: FREE_BUYER_CODES.BUSY,
      });
      release(connection);
      await operation;
      assert.equal(closes, 1);
      assert.equal(prepared.stats.rows.size, 0);
    } finally {
      release(connection);
      await operation;
    }
  },
);
