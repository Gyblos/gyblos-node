// Common home ownership prevents mode changes from racing before any financial state exists.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { withBuyerRuntime } from '@gyblos/node/buyer-runtime';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

void test('one lifetime guard excludes a second financial mode before its factory and releases after close', async () => {
  const environment = {
    GYBLOS_HOME: await mkdtemp(join(tmpdir(), 'gyb-buyer-runtime-')),
  };
  let constructed = 0;
  const create = async () => {
    constructed++;
    return { close: async () => {} };
  };
  const first = await withBuyerRuntime(environment, create);
  await assert.rejects(withBuyerRuntime(environment, create), {
    code: SESSION_CODES.UNAVAILABLE,
  });
  assert.equal(constructed, 1);
  await first.close();
  const next = await withBuyerRuntime(environment, create);
  await next.close();
  assert.equal(constructed, 2);
});

void test('startup failure and final inspection both release common lifetime ownership', async () => {
  const environment = {
    GYBLOS_HOME: await mkdtemp(join(tmpdir(), 'gyb-buyer-runtime-')),
  };
  await assert.rejects(
    withBuyerRuntime(environment, async () => {
      throw new Error('Synthetic startup failure');
    }),
  );
  const host = await withBuyerRuntime(environment, async () => ({
    close: async () => {},
    inspectAndClose: async (_digest: string) => undefined,
  }));
  await host.inspectAndClose('synthetic-digest');
  const next = await withBuyerRuntime(environment, async () => ({
    close: async () => {},
  }));
  await next.close();
});
