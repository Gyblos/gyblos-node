// Simulates losing the desktop HTTP connection on either side of inference authorization.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { X402Budget } from '@gyblos/desktop/x402-budget';
import { desktopOpening } from '@gyblos/node/desktop-opening';

import { policy } from './support/desktop-paid-chat';

for (const dispatched of [false, true]) {
  void test(`restarted desktop reconciles the exact opening with inference dispatched = ${dispatched}`, async () => {
    const environment = {
      GYBLOS_HOME: await mkdtemp(join(tmpdir(), 'gyb-opening-')),
    };
    let saved: string | undefined;
    const files = {
      read: async () => saved,
      write: async (text: string) => {
        saved = text;
      },
    };
    const ledger = new X402Budget(files, desktopOpening(environment));
    const intent = randomUUID();
    await ledger.reserve('message-id', policy, intent);
    if (dispatched) await desktopOpening(environment).consume(intent);
    const restarted = new X402Budget(files, desktopOpening(environment));
    assert.equal((await restarted.summary()).blocked, dispatched);
    await assert.rejects(desktopOpening(environment).consume(intent));
    if (!dispatched) {
      await restarted.reserve('next-message', policy, randomUUID());
      await assert.rejects(desktopOpening(environment).consume(intent));
    }
  });
}
