// Common home ownership prevents mode changes from racing before any financial state exists.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { withBuyerRuntime } from '@gyblos/node/buyer-runtime';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';

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
    code: NODE_ERROR_CODES.BUYER_RUNTIME_UNAVAILABLE,
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

for (const inspection of [false, true]) {
  void test(`common ownership stays held during ${inspection ? 'inspection versus close' : 'two overlapping closes'}`, async () => {
    const environment = {
      GYBLOS_HOME: await mkdtemp(join(tmpdir(), 'gyb-buyer-runtime-')),
    };
    let release: () => void = () => {};
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const draining = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closes = 0;
    const host = await withBuyerRuntime(environment, async () => ({
      close: async () => {
        closes++;
        if (!inspection && closes === 1) {
          ready();
          await draining;
        }
      },
      inspectAndClose: async (_digest: string) => {
        ready();
        await draining;
        return undefined;
      },
    }));
    const first = inspection ? host.inspectAndClose('synthetic') : host.close();
    await started;
    const second = host.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await assert.rejects(
        withBuyerRuntime(environment, async () => ({ close: async () => {} })),
        { code: NODE_ERROR_CODES.BUYER_RUNTIME_UNAVAILABLE },
      );
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
    const next = await withBuyerRuntime(environment, async () => ({
      close: async () => {},
    }));
    await next.close();
  });
}

void test('a host inspection can call its own close without recursively awaiting the wrapper', async () => {
  const environment = {
    GYBLOS_HOME: await mkdtemp(join(tmpdir(), 'gyb-buyer-runtime-')),
  };
  let closed = 0;
  const source = {
    close: async () => {
      closed++;
    },
    inspectAndClose: async (_digest: string) => {
      await source.close();
      return undefined;
    },
  };
  const host = await withBuyerRuntime(environment, async () => source);
  const inspected = host.inspectAndClose('synthetic');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  await inspected;
  const next = await withBuyerRuntime(environment, async () => ({
    close: async () => {},
  }));
  await next.close();
});
