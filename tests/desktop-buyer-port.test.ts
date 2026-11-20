// Starts the real local HTTP listener in a temporary buyer home; no seller, wallet or inference is used.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import {
  prepareDesktopBuyer,
  startDesktopBuyer,
} from '@gyblos/buyer/desktop-startup';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { PORTS } from '@gyblos/config';

import { home, role } from './support/buyer-init';

function listen(options: { port: number }) {
  return startFreeBuyerHttp(
    async () => {
      throw new Error('inference must not run');
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 1,
    },
    options,
  );
}

void test('desktop restarts keep the same dedicated agent API origin', async () => {
  const fixture = await home();
  const options = {
    environment: fixture.environment,
    prepareRole: async () => role(),
  };
  try {
    const first = await startDesktopBuyer(options, listen);
    const original = new URL(first.url).origin;
    await first.close();
    const second = await startDesktopBuyer(options, listen);
    try {
      assert.equal(new URL(second.url).origin, original);
      assert.equal(new URL(second.url).port, String(PORTS.desktopBuyer));
      assert.notEqual(PORTS.desktopBuyer, PORTS.buyerProxy);
    } finally {
      await second.close();
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('an occupied desktop API port fails closed without choosing a new origin', async () => {
  const fixture = await home();
  const existing = await listen({ port: 4033 });
  let started: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    await assert.rejects(
      async () => {
        started = await startDesktopBuyer(
          { environment: fixture.environment, prepareRole: async () => role() },
          listen,
        );
      },
      { code: 'EADDRINUSE' },
    );
  } finally {
    await started?.close();
    await existing.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('cancelling an existing desktop profile before preparation returns never starts a listener', async () => {
  const fixture = await home();
  const controller = new AbortController();
  let starts = 0;
  const options = {
    environment: fixture.environment,
    prepareRole: async () => role(),
  };
  try {
    await prepareDesktopBuyer(options);
    const starting = startDesktopBuyer(
      { ...options, signal: controller.signal },
      async () => {
        starts++;
        return {};
      },
    );
    controller.abort();
    await assert.rejects(starting, { name: 'AbortError' });
    assert.equal(starts, 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
