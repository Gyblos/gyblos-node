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

void test('Payments checks the finalized charge for the original dispatched chat after restart', async () => {
  const environment = {
    GYBLOS_HOME: await mkdtemp(join(tmpdir(), 'gyb-review-')),
  };
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  const opening = desktopOpening(environment);
  const intent = randomUUID();
  const binding = {
    channelId: '1'.repeat(32),
    requestId: 'aa'.repeat(16),
    sellerNodeId: 'bb'.repeat(32),
    baseAtomic: '0',
  };
  await new X402Budget(files, opening).reserve('message-id', policy, intent);
  await opening.consume(intent, binding);
  const restarted = new X402Budget(files, opening);
  assert.equal(await restarted.review(async () => undefined), false);
  assert.equal((await restarted.summary()).blocked, true);
  assert.equal(
    await restarted.review(async (ref) => {
      assert.deepEqual(ref, binding);
      return { chargeAtomic: '0', transaction: '1'.repeat(64) };
    }),
    true,
  );
  assert.equal((await restarted.summary()).blocked, false);
});
