// Native SDK/channel admission proves separated buyers, bounded capacity and persisted obligations.
import assert from 'node:assert/strict';
import filesystem, { readFile, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';

import { FILE_MODES } from '@gyblos/config';
import { batchSellerBuyerPaths } from '@gyblos/config/home';
import {
  openBatchSellerBackend,
  openBatchSellerRegistry,
} from '@gyblos/payments-upto/batch-session';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { sellerRegistryRig } from '../support/seller-session-registry';

void test('competing buyers cannot reserve the last slot twice; only proved closure releases it', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1);
  t.after(rig.dispose);
  const registry = await rig.open();
  t.after(registry.dispose);
  const before = rig.vm.sends();
  const candidates = rig.buyers.slice(0, 2);
  const results = await Promise.allSettled(
    candidates.map((row) =>
      registry.backend(row.terms.buyerNodeId).create(row.terms, row.payload),
    ),
  );
  const winners = results.flatMap((result, index) =>
    result.status === 'fulfilled'
      ? [{ session: result.value, row: candidates[index]! }]
      : [],
  );
  assert.equal(winners.length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason.code === SESSION_CODES.BUSY,
    ).length,
    1,
  );
  const winner = winners[0]!;
  t.after(winner.session.dispose);
  assert.equal(
    rig.vm.sends(),
    before,
    'a reserved slot never submits the deposit',
  );
  const outside = rig.buyers[2]!;
  assert.equal(await registry.permits(outside.terms.buyerNodeId), false);
  const first = await winner.session.open(winner.row.payload);
  await winner.session.open(winner.row.payload);
  assert.equal(
    rig.vm.sends(),
    before + 1,
    'duplicate OPEN keeps one exact deposit',
  );
  const closed = await winner.session.close();
  assert.equal(closed.channelId, first.channelId);
  assert.equal(closed.chargedAtomic, '0');
  assert.equal(closed.refundedAtomic, '1000');
  assert.equal(await registry.permits(outside.terms.buyerNodeId), true);
  const next = await registry
    .backend(outside.terms.buyerNodeId)
    .create(outside.terms, outside.payload);
  t.after(next.dispose);
  assert.equal(
    (await registry.list()).length,
    1,
    'only the unfinished buyer remains in the active index',
  );
  assert.equal(
    (await registry.backend(winner.row.terms.buyerNodeId).inspect())?.snapshot
      .channelId,
    closed.channelId,
  );
  assert.equal(
    await registry.permits(
      candidates.find((row) => row !== winner.row)!.terms.buyerNodeId,
    ),
    false,
  );
});

void test('lost native opening acknowledgment keeps its slot and restores one original deposit', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1);
  t.after(rig.dispose);
  let registry = await rig.open();
  t.after(() => registry.dispose());
  const row = rig.buyers[0]!;
  let seller = await registry
    .backend(row.terms.buyerNodeId)
    .create(row.terms, row.payload);
  t.after(() => seller.dispose());
  rig.vm.loseConfirmation(true);
  await assert.rejects(seller.open(row.payload));
  const sent = rig.vm.sends();
  assert.equal(await rig.vm.balance(row.terms.buyer), 99000n);
  assert.equal(await registry.permits(rig.buyers[1]!.terms.buyerNodeId), false);
  await seller.dispose();
  await registry.dispose();
  rig.vm.loseConfirmation(false);
  registry = await rig.open();
  seller = await registry.backend(row.terms.buyerNodeId).create(row.terms);
  await seller.open(row.payload);
  assert.equal(rig.vm.sends(), sent);
  assert.equal(await rig.vm.balance(row.terms.buyer), 99000n);
});

for (const failAt of [1, 2]) {
  void test(`interrupted seller reservation publication ${failAt} restores without submitting a deposit`, async (t) => {
    t.mock.method(Date, 'now', () => 1_800_000_000_000);
    t.mock.method(globalThis, 'fetch', async () =>
      assert.fail('External RPC forbidden'),
    );
    const rig = await sellerRegistryRig(1);
    t.after(rig.dispose);
    let registry = await rig.open();
    t.after(() => registry.dispose());
    const rename = filesystem.rename;
    let publications = 0;
    const patched = t.mock.method(
      filesystem,
      'rename',
      (...args: Parameters<typeof filesystem.rename>) => {
        if (args[1] === rig.paths.state && ++publications === failAt)
          throw new Error('Synthetic index publication failure');
        return rename(...args);
      },
    );
    const restore = () => {
      patched.mock.restore();
      syncBuiltinESMExports();
    };
    t.after(restore);
    syncBuiltinESMExports();
    const row = rig.buyers[0]!;
    const before = rig.vm.sends();
    await assert.rejects(
      registry.backend(row.terms.buyerNodeId).create(row.terms, row.payload),
      { code: SESSION_CODES.UNAVAILABLE },
    );
    await assert.rejects(registry.permits(rig.buyers[1]!.terms.buyerNodeId), {
      code: SESSION_CODES.UNAVAILABLE,
    });
    restore();
    await registry.dispose();
    registry = await rig.open();
    assert.equal(rig.vm.sends(), before);
    assert.equal((await registry.list()).length, failAt === 1 ? 0 : 1);
    const seller = await registry
      .backend(row.terms.buyerNodeId)
      .create(row.terms, row.payload);
    t.after(seller.dispose);
    await seller.open(row.payload);
    assert.equal(rig.vm.sends(), before + 1);
  });
}

void test('missing indexed financial state and orphaned funded children never become free capacity', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1);
  t.after(rig.dispose);
  let registry = await rig.open();
  t.after(() => registry.dispose());
  const row = rig.buyers[0]!;
  const seller = await registry
    .backend(row.terms.buyerNodeId)
    .create(row.terms, row.payload);
  await seller.open(row.payload);
  await seller.dispose();
  const path = batchSellerBuyerPaths(rig.paths, row.terms.buyerNodeId).state;
  const saved = await readFile(path, 'utf8');
  const before = rig.vm.sends();
  await unlink(path);
  await assert.rejects(registry.permits(rig.buyers[1]!.terms.buyerNodeId), {
    code: SESSION_CODES.UNVERIFIED,
  });
  await writeFile(path, saved, { mode: FILE_MODES.privateFile });
  await registry.dispose();
  await unlink(rig.paths.state);
  await assert.rejects(rig.open(), { code: SESSION_CODES.UNVERIFIED });
  assert.equal(rig.vm.sends(), before);
});

void test(
  'a seller persists two independent buyers and restores obligations after lowering max_sessions',
  {},
  async (t) => {
    t.mock.method(Date, 'now', () => 1_800_000_000_000);
    t.mock.method(globalThis, 'fetch', async () =>
      assert.fail('External RPC forbidden'),
    );
    const rig = await sellerRegistryRig(2);
    t.after(rig.dispose);
    let registry = await rig.open();
    t.after(() => registry.dispose());
    const a = rig.buyers[0]!;
    const b = rig.buyers[1]!;
    const c = rig.buyers[2]!;
    const first = await registry
      .backend(a.terms.buyerNodeId)
      .create(a.terms, a.payload);
    const second = await registry
      .backend(b.terms.buyerNodeId)
      .create(b.terms, b.payload);
    t.after(first.dispose);
    t.after(second.dispose);
    assert.equal((await registry.list()).length, 2);
    assert.equal(await registry.permits(c.terms.buyerNodeId), false);
    const baseline = rig.vm.sends();
    await first.open(a.payload);
    await second.open(b.payload);
    assert.equal(rig.vm.sends(), baseline + 2);
    assert.notEqual(first.snapshot().channelId, second.snapshot().channelId);
    await assert.rejects(
      registry.backend(c.terms.buyerNodeId).create(c.terms, c.payload),
      { code: SESSION_CODES.BUSY },
    );
    const one = JSON.parse(
      await readFile(
        batchSellerBuyerPaths(rig.paths, a.terms.buyerNodeId).state,
        'utf8',
      ),
    );
    const two = JSON.parse(
      await readFile(
        batchSellerBuyerPaths(rig.paths, b.terms.buyerNodeId).state,
        'utf8',
      ),
    );
    assert.equal(one.terms.buyerNodeId, a.terms.buyerNodeId);
    assert.equal(two.terms.buyerNodeId, b.terms.buyerNodeId);
    await first.dispose();
    await second.dispose();
    await registry.dispose();
    registry = await rig.open(1);
    const restored = await registry.list();
    assert.equal(restored.length, 2);
    assert.ok(
      restored.every(
        (entry) => entry.stored.snapshot.state === SESSION_STATES.OPEN,
      ),
    );
    assert.equal(await registry.permits(a.terms.buyerNodeId), true);
    assert.equal(await registry.permits(b.terms.buyerNodeId), true);
    assert.equal(await registry.permits(c.terms.buyerNodeId), false);
    assert.equal(
      rig.vm.sends(),
      baseline + 2,
      'restoring or lowering a cap sends no transaction',
    );
  },
);

void test('legacy seller obligations remain at their original path and consume capacity without a pin', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1);
  t.after(rig.dispose);
  const row = rig.buyers[0]!;
  const old = await openBatchSellerBackend({
    ...rig.options,
    paths: rig.paths.legacy,
  }).create(row.terms, row.payload);
  const opened = await old.open(row.payload);
  await old.dispose();
  const original = await readFile(rig.paths.legacy.state, 'utf8');
  const registry = await rig.open();
  t.after(registry.dispose);
  assert.equal(
    (await registry.list())[0]?.stored.snapshot.channelId,
    opened.channelId,
  );
  assert.equal(await registry.permits(rig.buyers[1]!.terms.buyerNodeId), false);
  const restored = await registry
    .backend(row.terms.buyerNodeId)
    .create(row.terms);
  t.after(restored.dispose);
  assert.equal(restored.snapshot().channelId, opened.channelId);
  assert.equal(await readFile(rig.paths.legacy.state, 'utf8'), original);
  await assert.rejects(
    readFile(batchSellerBuyerPaths(rig.paths, row.terms.buyerNodeId).state),
    { code: 'ENOENT' },
  );
  await restored.close();
  assert.equal(await registry.permits(rig.buyers[1]!.terms.buyerNodeId), true);
});

void test('corrupt index input is a static typed refusal before any new financial construction', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(1);
  t.after(rig.dispose);
  const registry = await rig.open();
  const row = rig.buyers[0]!;
  const seller = await registry
    .backend(row.terms.buyerNodeId)
    .create(row.terms, row.payload);
  await seller.dispose();
  await registry.dispose();
  const before = rig.vm.sends();
  await writeFile(rig.paths.state, '{"unrecognized":true}', {
    mode: FILE_MODES.privateFile,
  });
  await assert.rejects(rig.open(), { code: SESSION_CODES.UNAVAILABLE });
  assert.equal(rig.vm.sends(), before);
});

void test('64 settled buyers retain their proofs after restart while an uncertain opening still consumes capacity', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const rig = await sellerRegistryRig(2, { buyerCount: 66 });
  t.after(rig.dispose);
  let registry = await rig.open();
  t.after(() => registry.dispose());
  for (const buyer of rig.buyers.slice(0, 64)) {
    const seller = await registry
      .backend(buyer.terms.buyerNodeId)
      .create(buyer.terms, buyer.payload);
    try {
      await seller.open(buyer.payload);
      await seller.close();
    } finally {
      await seller.dispose();
    }
  }
  const uncertain = rig.buyers[64]!;
  const seller = await registry
    .backend(uncertain.terms.buyerNodeId)
    .create(uncertain.terms, uncertain.payload);
  rig.vm.loseConfirmation(true);
  try {
    await assert.rejects(seller.open(uncertain.payload));
  } finally {
    await seller.dispose();
  }
  await registry.dispose();
  registry = await rig.open(1);
  assert.deepEqual(
    (await registry.list()).map((row) => row.buyerNodeId),
    [uncertain.terms.buyerNodeId],
  );
  const first = rig.buyers[0]!;
  const stored = await registry.backend(first.terms.buyerNodeId).inspect();
  assert.equal(stored?.archivedProof, true);
  assert.equal(
    await registry.permits(rig.buyers[65]!.terms.buyerNodeId),
    false,
  );
  assert.equal(await registry.permits(first.terms.buyerNodeId), false);
});

void test('a never-funded opening frees its slot for the next buyer, across a restart, and its buyer waits for capacity', async (t) => {
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
  const [first, second] = rig.buyers;
  const failed = await registry
    .backend(first!.terms.buyerNodeId)
    .create(first!.terms, first!.payload);
  const before = rig.vm.sends();
  await assert.rejects(failed.open(first!.payload));
  await failed.dispose();
  assert.equal(rig.vm.sends(), before, 'nothing was sent');
  assert.equal(
    (await registry.backend(first!.terms.buyerNodeId).inspect())?.snapshot
      .channelId,
    '',
  );
  // The slot is free for another buyer, and stays free after a restart.
  assert.equal(await registry.permits(second!.terms.buyerNodeId), true);
  await registry.dispose();
  registry = await open();
  t.after(() => registry.dispose());
  assert.equal(await registry.permits(second!.terms.buyerNodeId), true);
  refuse = false;
  const next = await registry
    .backend(second!.terms.buyerNodeId)
    .create(second!.terms, second!.payload);
  t.after(next.dispose);
  await next.open(second!.payload);
  assert.equal(rig.vm.sends(), before + 1, 'the next buyer deposited');
  // The released buyer now waits for capacity like any other.
  assert.equal(await registry.permits(first!.terms.buyerNodeId), false);
  await assert.rejects(
    registry
      .backend(first!.terms.buyerNodeId)
      .create(first!.terms, first!.payload),
    { code: SESSION_CODES.BUSY },
  );
});
