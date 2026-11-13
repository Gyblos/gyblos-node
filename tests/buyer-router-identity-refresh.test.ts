// A registry decision must be refreshed after quoting; cancellation cannot strand selection admission.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Endpoint } from '@number0/iroh';

import { freeAdmission } from '@gyblos/buyer/free-parallel';
import { selectWinner } from '@gyblos/buyer/free-selection';
import {
  IDENTITY_POLICY_CODES,
  IDENTITY_TRUST_SOURCES,
} from '@gyblos/core/identity-policy';

import { selectionFixture } from './support/buyer-selection';
import { socketStream } from './support/control-loopback';

void test('a paid winner is refused when identity changes during its quote', async (t) => {
  const run = await selectionFixture();
  t.after(run.wire.close);
  run.context.endpoint = { relayUrl: null, directAddresses: [] };
  run.context.relayOnly = false;
  let checks = 0;
  let accepted = 0;
  const transport = {
    id: () => ({ toString: () => run.request.params.buyerNodeId }),
    connect: async () => ({
      remoteId: () => ({ toString: () => run.catalog.nodeId }),
      closeReason: () => null,
      close: () => {},
      openBi: async () => socketStream(await run.wire.socket()),
    }),
  };
  const endpoint = transport as unknown as Endpoint;
  const prepared = {
    discovery: undefined,
    config: { ...run.config, identity: { rpcUrl: 'https://rpc.invalid' } },
    stats: { rows: new Map(), save: async () => {} },
    identity: {
      verify: async () =>
        ++checks === 1
          ? { ok: true as const, source: IDENTITY_TRUST_SOURCES.MANUAL }
          : { ok: false as const, code: IDENTITY_POLICY_CODES.REVOKED },
    },
  };
  await assert.rejects(async () => {
    await selectWinner(
      prepared,
      {
        endpoint,
        buyer: run.request.params.buyer,
        relayOnly: false,
        now: run.context.now,
      },
      new Set(),
      AbortSignal.timeout(3000),
      run.config.request,
    );
    accepted++;
  });
  assert.equal(checks, 2);
  assert.equal(accepted, 0);
});

void test('an already cancelled selection cannot strand the next turn', async () => {
  const admission = freeAdmission(2);
  await assert.rejects(async () =>
    admission.select(new Set(), AbortSignal.abort(), async () => ({
      nodeId: 'never',
    })),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    assert.deepEqual(
      await admission.select(new Set(), controller.signal, async () => ({
        nodeId: 'ok',
      })),
      { nodeId: 'ok' },
    );
  } finally {
    clearTimeout(timer);
  }
});
