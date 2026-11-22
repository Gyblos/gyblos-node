import assert from 'node:assert/strict';
import test from 'node:test';

import { sellerProfileTombstone } from '@gyblos/discovery-index/profile-store';
import { createD1SellerProfileStore } from '@gyblos/discovery-index/profile-store-d1';
import { runSellerProfiles } from '@gyblos/discovery-index/seller-profiles-admin';

import { createSqliteD1 } from './support/d1-sqlite';

const NOW = 1_800_000_000_000;
const node = (index: number) => index.toString(16).padStart(64, '0');
const row = (index: number, name: string) => ({
  nodeId: node(index),
  name,
  issuedAt: NOW - index,
  signature: 'ab'.repeat(64),
  held: false as const,
});

void test('the operator lists names, holds one so the seller cannot replace it, and releases it', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const profiles = createD1SellerProfileStore(db);
  await profiles.put(row(1, 'Ada'));
  await profiles.put(row(2, 'Bad Name'));
  await profiles.put(sellerProfileTombstone(node(3), NOW));
  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const targets: string[] = [];
    const code = runSellerProfiles(argv, {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      now: () => NOW,
      query: (sql, remote) => {
        targets.push(`query:${remote}`);
        return db.raw.prepare(sql).all();
      },
      execute: (sql, remote) => {
        targets.push(`execute:${remote}`);
        db.raw.exec(sql);
      },
    });
    return { code, out: out.join(''), err: err.join(''), targets };
  };
  const listed = run([]);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.targets, ['query:false']);
  assert.ok(listed.out.includes(`${node(1)}\tAda\tno\t`));
  assert.ok(listed.out.includes(`${node(2)}\tBad Name\tno\t`));
  assert.ok(!listed.out.includes(node(3)));
  assert.match(listed.out, /2 name\(s\)\n$/);

  const held = run(['--hold', node(2), '--remote']);
  assert.equal(held.code, 0);
  assert.deepEqual(held.targets, ['execute:true']);
  assert.match(held.out, /remote database/);
  assert.deepEqual(await profiles.get(node(2)), {
    ...sellerProfileTombstone(node(2), NOW - 2, true),
  });
  assert.equal(await profiles.put(row(2, 'Again')), false);
  assert.equal(
    await profiles.put({ ...row(2, 'Again'), issuedAt: NOW + 1 }),
    false,
  );
  const local = run(['--hold', node(4), '--local']);
  assert.equal(local.code, 0);
  assert.deepEqual(local.targets, ['execute:false']);
  assert.match(local.out, /local database/);
  assert.deepEqual(
    await profiles.get(node(4)),
    sellerProfileTombstone(node(4), NOW, true),
  );
  assert.match(run([]).out, new RegExp(`${node(2)}\\t-\\tyes\\t`));

  assert.equal(run(['--release', node(2), '--local']).code, 0);
  assert.deepEqual(
    await profiles.get(node(2)),
    sellerProfileTombstone(node(2), NOW - 2),
  );
  assert.equal(
    await profiles.put({ ...row(2, 'Again'), issuedAt: NOW + 1 }),
    true,
  );

  for (const argv of [
    ['--hold', 'AB'.repeat(32)],
    ['--hold'],
    ['--hold', node(1), '--release', node(1), '--local'],
    ['--hold', node(1)],
    ['--release', node(1)],
    ['--hold', node(1), '--local', '--remote'],
    ['--local'],
    ['--nope'],
  ]) {
    const bad = run(argv);
    assert.equal(bad.code, 1, argv.join(' '));
    assert.deepEqual(bad.targets, []);
    assert.match(bad.err, /usage/);
  }
});

void test('the operator listing says when it stopped at 1,000 rows', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    node_id: node(index),
    name: 'Ada',
    held: 0,
    issued_at: NOW,
  }));
  const out: string[] = [];
  const code = runSellerProfiles([], {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    now: () => NOW,
    query: () => rows,
    execute: () => assert.fail('wrote'),
  });
  assert.equal(code, 0);
  assert.match(out.join(''), /1000 name\(s\); the list stops at 1,000 rows/);
});
