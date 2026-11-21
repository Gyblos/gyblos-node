// A seller opening whose deposit was never funded is released: it frees its slot and leaves the buyer
// index, so neither capacity nor the index fills with sessions that hold nothing. Synthetic LiteSVM.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openBatchSellerRegistry } from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { sellerRegistryRig } from '../support/seller-session-registry';

void test('released openings free their slot and leave the index; their buyers return within capacity', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1);
  t.after(rig.dispose);
  let refuse = true;
  const signer = {
    ...rig.vm.signer,
    // A refused simulation: the deposit is never sent.
    simulateTransaction: async (
      ...args: Parameters<typeof rig.vm.signer.simulateTransaction>
    ) => {
      if (refuse) throw new Error('synthetic simulation refusal');
      return rig.vm.signer.simulateTransaction(...args);
    },
  };
  const open = () =>
    openBatchSellerRegistry({ ...rig.options, signer, maxSessions: 1 });
  let registry = await open();
  const [first, second, third] = rig.buyers;
  const before = rig.vm.sends();
  // Two buyers in turn fail before any deposit: each is released in its turn.
  for (const row of [first!, second!]) {
    const failed = await registry
      .backend(row.terms.buyerNodeId)
      .create(row.terms, row.payload);
    await assert.rejects(failed.open(row.payload));
    await failed.dispose();
    assert.equal(
      (await registry.backend(row.terms.buyerNodeId).inspect())?.snapshot
        .channelId,
      '',
    );
  }
  assert.equal(rig.vm.sends(), before, 'nothing was sent');
  assert.deepEqual(
    await registry.list(),
    [],
    'released sessions left the index',
  );
  // The slot stays free across a restart, and a third buyer takes it.
  await registry.dispose();
  registry = await open();
  t.after(() => registry.dispose());
  assert.equal(await registry.permits(third!.terms.buyerNodeId), true);
  refuse = false;
  const next = await registry
    .backend(third!.terms.buyerNodeId)
    .create(third!.terms, third!.payload);
  t.after(next.dispose);
  await next.open(third!.payload);
  assert.equal(rig.vm.sends(), before + 1, 'the third buyer deposited');
  // A released buyer returns only within capacity.
  assert.equal(await registry.permits(first!.terms.buyerNodeId), false);
  await assert.rejects(
    registry
      .backend(first!.terms.buyerNodeId)
      .create(first!.terms, first!.payload),
    { code: SESSION_CODES.BUSY },
  );
  await next.close();
  assert.equal(await registry.permits(first!.terms.buyerNodeId), true);
  const returned = await registry
    .backend(first!.terms.buyerNodeId)
    .create(first!.terms, first!.payload);
  t.after(returned.dispose);
  await returned.open(first!.payload);
  assert.deepEqual(
    (await registry.list()).map((row) => row.buyerNodeId),
    [first!.terms.buyerNodeId],
    'the returning buyer is indexed again before its deposit',
  );
});

void test('a readmitted released buyer holds the slot from create, before it opens', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1);
  t.after(rig.dispose);
  let refuse = true;
  const signer = {
    ...rig.vm.signer,
    simulateTransaction: async (
      ...args: Parameters<typeof rig.vm.signer.simulateTransaction>
    ) => {
      if (refuse) throw new Error('synthetic simulation refusal');
      return rig.vm.signer.simulateTransaction(...args);
    },
  };
  const registry = await openBatchSellerRegistry({
    ...rig.options,
    signer,
    maxSessions: 1,
  });
  t.after(() => registry.dispose());
  const [first, second] = rig.buyers;
  const failed = await registry
    .backend(first!.terms.buyerNodeId)
    .create(first!.terms, first!.payload);
  await assert.rejects(failed.open(first!.payload));
  await failed.dispose();
  refuse = false;
  // A is readmitted: from here it holds the only slot, before its opening.
  const readmitted = await registry
    .backend(first!.terms.buyerNodeId)
    .create(first!.terms, first!.payload);
  t.after(readmitted.dispose);
  assert.equal(await registry.permits(second!.terms.buyerNodeId), false);
  await assert.rejects(
    registry
      .backend(second!.terms.buyerNodeId)
      .create(second!.terms, second!.payload),
    { code: SESSION_CODES.BUSY },
  );
  assert.deepEqual(
    (await registry.list()).map((row) => row.buyerNodeId),
    [first!.terms.buyerNodeId],
  );
  await readmitted.open(first!.payload);
  assert.deepEqual(
    (await registry.list()).map((row) => row.buyerNodeId),
    [first!.terms.buyerNodeId],
    'one channel, indexed',
  );
});
