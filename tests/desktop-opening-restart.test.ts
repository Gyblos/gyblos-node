// Simulates losing the desktop HTTP connection on either side of inference authorization.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createX402Handlers } from '@gyblos/desktop/x402-handlers';
import { X402_ACTION } from '@gyblos/desktop/x402-model';
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

void test('Payments records the confirmed desktop charge when another seller still needs review', async (t) => {
  const opening = desktopOpening({
    GYBLOS_HOME: await mkdtemp(join(tmpdir(), 'gyb-paid-review-')),
  });
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  const intent = randomUUID();
  await new X402Budget(files, opening).reserve(
    'reviewed-message',
    policy,
    intent,
  );
  await opening.consume(intent, {
    channelId: '1'.repeat(32),
    requestId: 'aa'.repeat(16),
    sellerNodeId: 'bb'.repeat(32),
    baseAtomic: '0',
  });
  const budget = new X402Budget(files, opening);
  const client = new X402Client(budget);
  t.mock.method(client, 'policy', () => policy);
  const reconcile = t.mock.method(client, 'reconcileReviewedPool', async () => {
    assert.equal((await budget.summary()).blocked, false);
    throw new Error('a different channel is unresolved');
  });
  const frame = {};
  const handle = createX402Handlers(
    client,
    budget,
    { contents: frame, mainFrame: () => frame, destroyed: () => false },
    async () => {},
    {
      start: async () => {},
      review: async () => ({ chargeAtomic: '1', transaction: '1'.repeat(64) }),
    },
  );
  const result = await handle({ sender: frame, senderFrame: frame }, [
    { action: X402_ACTION.REVIEW },
  ]);
  assert.equal(reconcile.mock.callCount(), 1);
  assert.equal(result.summary.blocked, false);
  assert.equal(result.summary.records.at(-1)?.chargeAtomic, '1');
  assert.match(result.error ?? '', /payment is confirmed/i);
  reconcile.mock.mockImplementation(async () => {});
  const checked = await handle({ sender: frame, senderFrame: frame }, [
    { action: X402_ACTION.REVIEW },
  ]);
  assert.equal(reconcile.mock.callCount(), 2);
  assert.equal(checked.error, undefined);
  assert.equal(checked.summary.records.length, result.summary.records.length);
});

void test('retiring a desktop request cannot race an authorized channel switch', async () => {
  const env = { GYBLOS_HOME: await mkdtemp(join(tmpdir(), 'gyb-switch-')) };
  const permission = desktopOpening(env);
  const id = randomUUID();
  await permission.arm(id);
  await permission.whileArmed(id, async () => {
    await assert.rejects(permission.retire(id));
  });
  assert.equal(await permission.retire(id), true);
  await assert.rejects(
    permission.whileArmed(id, async () =>
      assert.fail('retired channel switch'),
    ),
  );
});
