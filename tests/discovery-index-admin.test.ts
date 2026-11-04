// Owns the founder's enrollment commands (apps/discovery-index/scripts/admin.ts): an invite code the
// index accepts, only its hash in the SQL, validated contact, days and NodeId, and a revoke that stops
// publishing. The SQL runs against the real migrations in SQLite; no Wrangler or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  base32,
  newInvite,
  runAdmin,
  type AdminIo,
} from '@gyblos/discovery-index/admin';
import { REGISTRATION } from '@gyblos/discovery-index/constants';
import { inviteHash } from '@gyblos/discovery-index/registrations';

import {
  CLIENT_IP,
  expectError,
  INDEX_ORIGIN,
  indexNode,
} from './support/discovery-index-fixture';
import { enrollmentHarness } from './support/registration-fixture';

function admin(execute: (sql: string) => void, now: number) {
  let stdout = '';
  let stderr = '';
  const statements: string[] = [];
  const output: AdminIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    execute: (sql) => {
      statements.push(sql);
      execute(sql);
    },
    now: () => now,
    random: (bytes) => new Uint8Array(bytes).map((_byte, index) => index * 17),
  };
  return {
    run: (argv: string[]) => runAdmin(argv, output),
    out: () => ({ stdout, stderr, statements }),
  };
}

void test('index:invite prints a code the index redeems, and stores only its hash', async (context) => {
  const harness = await enrollmentHarness('sqlite-d1');
  if (!harness) return context.skip('node:sqlite unavailable');
  const db = harness.db!;
  const cli = admin((sql) => db.raw.exec(sql), harness.clock.now);
  assert.equal(
    cli.run(['invite', '--contact', 'seller@example.com', '--days', '3']),
    0,
  );
  const { stdout, statements } = cli.out();
  const code = /\n {2}(gyb_[a-z2-7]+)\n/.exec(stdout)?.[1];
  assert.ok(code && REGISTRATION.invite.test(code), stdout);
  assert.equal(statements.length, 1);
  assert.equal(statements[0]!.includes(code), false);
  assert.match(statements[0]!, new RegExp(await inviteHash(code)));
  assert.match(
    stdout,
    new RegExp(new Date(harness.clock.now + 3 * 86_400_000).toISOString()),
  );
  const seller = indexNode();
  assert.equal(
    (await harness.register({ invite: code, nodeId: seller.nodeId })).status,
    201,
  );

  // Revoked: its publishes are refused.
  const revoke = admin((sql) => db.raw.exec(sql), harness.clock.now);
  assert.equal(revoke.run(['revoke', seller.nodeId]), 0);
  await expectError(
    await harness.app.fetch(
      new Request(`${INDEX_ORIGIN}/v1/records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': CLIENT_IP,
        },
        body: JSON.stringify({ record: await seller.catalog(1) }),
      }),
    ),
    403,
    'PUBLISH_NOT_ALLOWED',
  );
});

void test('index:invite and index:revoke refuse bad input without touching D1', () => {
  for (const argv of [
    ['invite'],
    ['invite', '--contact', "x'); DROP TABLE discovery_invites; --"],
    ['invite', '--contact', 'a'.repeat(129)],
    ['invite', '--contact', 'seller@example.com', '--days', '0'],
    ['invite', '--contact', 'seller@example.com', '--days', '91'],
    ['invite', '--contact', 'seller@example.com', '--days', '1.5'],
    ['revoke'],
    ['revoke', 'AB'.repeat(32)],
    ['revoke', 'ab'.repeat(32), 'extra'],
    ['restore'],
    ['restore', 'xyz'],
    ['other'],
  ]) {
    const cli = admin(() => assert.fail('no SQL expected'), 0);
    assert.equal(cli.run(argv), 1, argv.join(' '));
    assert.equal(cli.out().statements.length, 0);
    assert.notEqual(cli.out().stderr, '');
  }
});

void test('invite codes are RFC 4648 base32 of 16 random bytes, hashed the same way the Worker hashes', async () => {
  // RFC 4648 section 10 vectors, lowercase and unpadded.
  const encode = (text: string) => base32(new TextEncoder().encode(text));
  assert.deepEqual(
    ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map(encode),
    ['', 'my', 'mzxq', 'mzxw6', 'mzxw6yq', 'mzxw6ytb', 'mzxw6ytboi'],
  );
  for (const fill of [0, 0xff, 0x5a]) {
    const { code, hash } = newInvite((bytes) =>
      new Uint8Array(bytes).fill(fill),
    );
    assert.match(code, REGISTRATION.invite);
    assert.equal(hash, await inviteHash(code));
  }
});
