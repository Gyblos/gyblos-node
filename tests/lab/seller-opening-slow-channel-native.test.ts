// A deposit this seller sent can land while the SDK's own RPC still hides the new channel: the SDK looks
// for it only a few seconds. The seller keeps observing the opening for a bounded time and opens, instead
// of answering unavailable and leaving the buyer an uncertain opening. Synthetic LiteSVM.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openBatchSellerRegistry } from '@gyblos/payments-upto/batch-session';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { sellerRegistryRig } from '../support/seller-session-registry';

void test('a sent deposit whose channel the SDK cannot see yet still opens', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1, { openingConfirmMs: 30_000 });
  t.after(rig.dispose);
  const [first] = rig.buyers;
  const channelId = (
    JSON.parse(first!.payload) as { voucher: { channelId: string } }
  ).voucher.channelId;
  // The SDK's RPC lags: its first reads of the landed channel come back empty, past its own retries (the
  // SDK reads 5 times; `hidden` reaching 0 below proves the SDK missed it and the seller found it).
  let hidden = 6;
  const signer = {
    ...rig.vm.signer,
    getAccountInfo: async (
      ...args: Parameters<NonNullable<typeof rig.vm.signer.getAccountInfo>>
    ) => {
      const account = await rig.vm.signer.getAccountInfo!(...args);
      if (account && String(args[0]) === channelId && hidden > 0) {
        hidden -= 1;
        return null;
      }
      return account;
    },
  } as typeof rig.vm.signer;
  const registry = await openBatchSellerRegistry({
    ...rig.options,
    signer,
    maxSessions: 1,
  });
  t.after(() => registry.dispose());
  const before = rig.vm.sends();
  const session = await registry
    .backend(first!.terms.buyerNodeId)
    .create(first!.terms, first!.payload);
  t.after(session.dispose);
  const opened = await session.open(first!.payload);
  assert.equal(opened.state, SESSION_STATES.OPEN);
  assert.equal(opened.channelId, channelId);
  assert.equal(rig.vm.sends(), before + 1, 'one deposit');
  assert.equal(hidden, 0, 'the SDK missed the channel first');
});

// Hides one account from both the SDK's signer and the seller's observation RPC until shown.
function hideChannel(
  rig: Awaited<ReturnType<typeof sellerRegistryRig>>,
  channelId: string,
) {
  const view = { hidden: true };
  const signer = {
    ...rig.vm.signer,
    getAccountInfo: async (
      ...args: Parameters<NonNullable<typeof rig.vm.signer.getAccountInfo>>
    ) =>
      view.hidden && String(args[0]) === channelId
        ? null
        : rig.vm.signer.getAccountInfo!(...args),
  } as typeof rig.vm.signer;
  const base = rig.options.rpc;
  const rpc = {
    ...base,
    getAccountInfo: (...args: Parameters<typeof base.getAccountInfo>) =>
      view.hidden && String(args[0]) === channelId
        ? {
            send: async () => ({
              value: null,
              context: { slot: rig.vm.slot() },
            }),
          }
        : base.getAccountInfo(...args),
  } as unknown as typeof base;
  return { view, signer, rpc };
}

void test('a sent deposit whose channel never shows is kept, bounded, and opens on the next try', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1, { openingConfirmMs: 30_000 });
  t.after(rig.dispose);
  const [first] = rig.buyers;
  const channelId = (
    JSON.parse(first!.payload) as { voucher: { channelId: string } }
  ).voucher.channelId;
  const { view, signer, rpc } = hideChannel(rig, channelId);
  const registry = await openBatchSellerRegistry({
    ...rig.options,
    signer,
    rpc,
    maxSessions: 1,
    openingConfirmMs: 3_000,
  });
  t.after(() => registry.dispose());
  const before = rig.vm.sends();
  const session = await registry
    .backend(first!.terms.buyerNodeId)
    .create(first!.terms, first!.payload);
  t.after(session.dispose);
  const started = performance.now();
  await assert.rejects(session.open(first!.payload), {
    code: SESSION_CODES.UNAVAILABLE,
  });
  assert.ok(performance.now() - started < 15_000, 'the wait is bounded');
  assert.equal(rig.vm.sends(), before + 1, 'the deposit was sent');
  // Nothing is released: the opening and its channel stay with the seller.
  const kept = await registry.backend(first!.terms.buyerNodeId).inspect();
  assert.equal(kept?.snapshot.channelId, channelId);
  assert.equal(kept?.snapshot.state, SESSION_STATES.OPENING);
  // Once the RPC shows it, the same opening completes without a second deposit.
  view.hidden = false;
  const opened = await session.open(first!.payload);
  assert.equal(opened.state, SESSION_STATES.OPEN);
  assert.equal(rig.vm.sends(), before + 1, 'still one deposit');
});

void test('an opening whose deposit was never sent fails at once, without waiting', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1, { openingConfirmMs: 30_000 });
  t.after(rig.dispose);
  const signer = {
    ...rig.vm.signer,
    simulateTransaction: async () => {
      throw new Error('synthetic simulation refusal');
    },
  } as typeof rig.vm.signer;
  const registry = await openBatchSellerRegistry({
    ...rig.options,
    signer,
    maxSessions: 1,
  });
  t.after(() => registry.dispose());
  const [first] = rig.buyers;
  const session = await registry
    .backend(first!.terms.buyerNodeId)
    .create(first!.terms, first!.payload);
  t.after(session.dispose);
  const started = performance.now();
  await assert.rejects(session.open(first!.payload));
  assert.ok(performance.now() - started < 5_000, 'no confirmation wait');
  // Released as before: the opening and its channel are forgotten.
  const released = await registry.backend(first!.terms.buyerNodeId).inspect();
  assert.equal(released?.snapshot.channelId, '');
});
