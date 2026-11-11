// Shared deposit authority is persistent, private and conservative; all keys and records are synthetic.
import assert from 'node:assert/strict';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { batchPoolChannelPaths, batchPoolPathsIn } from '@gyblos/config/home';
import { openBatchBuyerPool } from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

void test('pool persists two seller allocations, reuses A, and refuses an over-budget third seller before backend creation', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  let constructed = 0;
  const paths = batchPoolPathsIn({ GYBLOS_HOME: join(rig.root, 'pool') });
  const options = {
    paths,
    totalDepositAtomic: '2000',
    now: rig.now,
    backend: async () => {
      constructed++;
      throw new Error('No financial construction required');
    },
  };
  let pool = await openBatchBuyerPool(options);
  t.after(() => pool.dispose());
  const a = await pool.allocate(rig.terms);
  const b = await pool.allocate({
    ...rig.terms,
    sellerNodeId: '56'.repeat(32),
  });
  assert.deepEqual(await pool.allocate(rig.terms), a);
  assert.notEqual(a.terms.sellerNodeId, b.terms.sellerNodeId);
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '2000',
    availableAtomic: '0',
  });
  await assert.rejects(
    pool.allocate({ ...rig.terms, sellerNodeId: '78'.repeat(32) }),
    { code: SESSION_CODES.LIMIT },
  );
  assert.equal(constructed, 0);
  await pool.dispose();
  pool = await openBatchBuyerPool(options);
  assert.equal((await pool.list()).length, 2);
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '2000',
    availableAtomic: '0',
  });
});

void test('pool adopts the original legacy channel in place and counts its full idle deposit', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '40');
  const before = rig.buyer.snapshot();
  const paths = batchPoolPathsIn({ GYBLOS_HOME: rig.root });
  const pool = await openBatchBuyerPool({
    paths,
    totalDepositAtomic: '1000',
    now: rig.now,
    backend: async () => {
      throw new Error('not required');
    },
  });
  t.after(pool.dispose);
  const entries = await pool.list();
  assert.equal(entries[0]!.legacy, true);
  assert.equal(entries[0]!.stored!.snapshot.channelId, before.channelId);
  assert.equal(entries[0]!.stored!.snapshot.cumulativeAtomic, '40');
  await assert.rejects(
    pool.allocate({ ...rig.terms, sellerNodeId: '56'.repeat(32) }),
    { code: SESSION_CODES.LIMIT },
  );
  assert.deepEqual(await pool.budget(), {
    committedAtomic: '1000',
    availableAtomic: '0',
  });
  assert.deepEqual(rig.calls, ['deposit']);
});

void test('pool rejects changed financial bindings and another process owner without replacing the original allocation', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const paths = batchPoolPathsIn({ GYBLOS_HOME: join(rig.root, 'pool') });
  const options = {
    paths,
    totalDepositAtomic: '2000',
    now: rig.now,
    backend: async () => {
      throw new Error('not required');
    },
  };
  const pool = await openBatchBuyerPool(options);
  t.after(pool.dispose);
  await pool.allocate(rig.terms);
  await assert.rejects(openBatchBuyerPool(options));
  await assert.rejects(
    pool.allocate({ ...rig.terms, owner: rig.terms.buyer }),
    { code: SESSION_CODES.BINDING },
  );
  await assert.rejects(
    pool.allocate({
      ...rig.terms,
      sellerNodeId: '56'.repeat(32),
      buyerNodeId: '78'.repeat(32),
    }),
    { code: SESSION_CODES.BINDING },
  );
  assert.equal((await pool.list()).length, 1);
});

void test('missing ready child fails closed without creating a replacement or releasing commitment', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const paths = batchPoolPathsIn({ GYBLOS_HOME: join(rig.root, 'pool') });
  const options = {
    paths,
    totalDepositAtomic: '2000',
    now: rig.now,
    backend: async () => {
      throw new Error('must not construct');
    },
  };
  const pool = await openBatchBuyerPool(options);
  await pool.allocate(rig.terms);
  await unlink(batchPoolChannelPaths(paths, rig.terms.sellerNodeId).state);
  await assert.rejects(pool.list(), { code: SESSION_CODES.UNVERIFIED });
  await pool.dispose();
  await assert.rejects(openBatchBuyerPool(options), {
    code: SESSION_CODES.UNVERIFIED,
  });
});
void test('unready or unknown catalog fields cannot create refunded credit', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const paths = batchPoolPathsIn({ GYBLOS_HOME: join(rig.root, 'pool') });
  const options = {
    paths,
    totalDepositAtomic: '2000',
    now: rig.now,
    backend: async () => {
      throw new Error('must not construct');
    },
  };
  const pool = await openBatchBuyerPool(options);
  await pool.allocate(rig.terms);
  await pool.dispose();
  const raw: {
    version: number;
    entries: Array<{ ready: boolean; refundedAtomic: string }>;
  } = JSON.parse(await readFile(paths.state, 'utf8'));
  raw.entries[0]!.ready = false;
  raw.entries[0]!.refundedAtomic = '500';
  await writeFile(paths.state, JSON.stringify(raw));
  await assert.rejects(openBatchBuyerPool(options));
});
void test('catalog files are private and session count is bounded separately from budget', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const paths = batchPoolPathsIn({ GYBLOS_HOME: join(rig.root, 'pool') });
  const pool = await openBatchBuyerPool({
    paths,
    totalDepositAtomic: '17000',
    now: rig.now,
    backend: async () => {
      throw new Error('must not construct');
    },
  });
  t.after(pool.dispose);
  for (let index = 1; index <= 16; index++)
    await pool.allocate({
      ...rig.terms,
      sellerNodeId: index.toString(16).padStart(64, '0'),
    });
  await assert.rejects(
    pool.allocate({ ...rig.terms, sellerNodeId: 'ff'.repeat(32) }),
    { code: SESSION_CODES.LIMIT },
  );
  assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
});
