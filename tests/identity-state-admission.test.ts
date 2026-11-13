// Durable open-discovery admission reserves configured identities without dropping replay floors.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { DEVNET } from '@gyblos/config';
import { homeLayout, ROLE_FILES } from '@gyblos/config/home';
import {
  IDENTITY_LOOKUP_KINDS,
  IDENTITY_POLICY_CODES,
} from '@gyblos/core/identity-policy';
import { IDENTITY_STATE, NODE_ERROR_CODES } from '@gyblos/node/constants';
import { openBuyerIdentityState } from '@gyblos/node/identity-state';
import { canonicalJson } from '@gyblos/protocol';

const OWNER = '11111111111111111111111111111111';
const OTHER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SCOPE = { network: DEVNET, program: OWNER, collection: OWNER };
const id = (n: number) => n.toString(16).padStart(64, '0');
const input = (n: number, sequence = 1n) => ({
  nodeId: id(n),
  owner: OTHER,
  lookup: {
    kind: IDENTITY_LOOKUP_KINDS.BOUND,
    scope: SCOPE,
    nodeId: id(n),
    binding: { nodeId: id(n), owner: OWNER, asset: OWNER, sequence },
  },
});
async function fixture(t: TestContext, count = 0) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'gyb-identity-admission-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { GYBLOS_HOME: root };
  await openBuyerIdentityState(environment, SCOPE);
  const file = join(
    homeLayout(environment).roles.buyer,
    ROLE_FILES.identityState,
  );
  if (count)
    await writeFile(
      file,
      canonicalJson({
        schemaVersion: IDENTITY_STATE.schemaVersion,
        scope: SCOPE,
        rows: Array.from({ length: count }, (_, n) => ({
          binding: { nodeId: id(n), owner: OWNER, asset: OWNER, sequence: '1' },
          revoked: false,
        })),
      }),
      { mode: 0o600 },
    );
  return { environment, file };
}
void test('denied index identities cannot consume configured history reservations or poison the store', async (t) => {
  const f = await fixture(t, IDENTITY_STATE.maxRows - 1);
  const policy = { configuredNodeIds: [id(2000)] };
  const store = await openBuyerIdentityState(f.environment, SCOPE, policy);
  const before = await readFile(f.file, 'utf8');
  for (const n of [2001, 2002]) {
    const decision = await store.evaluate(input(n));
    assert.equal(!decision.ok && decision.code, IDENTITY_POLICY_CODES.LIMIT);
  }
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.equal(
    (await store.evaluate({ ...input(2000), owner: OWNER })).ok,
    true,
  );
  assert.equal(
    (await store.evaluate({ ...input(0, 2n), owner: OWNER })).ok,
    true,
  );
});
void test('64 owner-mismatch floors do not consume active discovery capacity, including after restart', async (t) => {
  const f = await fixture(t, 64);
  const policy = { configuredNodeIds: [id(2000)] };
  const store = await openBuyerIdentityState(f.environment, SCOPE, policy);
  for (let n = 0; n < 64; n++) {
    const denied = await store.evaluate(input(n, 2n));
    assert.equal(
      !denied.ok && denied.code,
      IDENTITY_POLICY_CODES.OWNER_MISMATCH,
    );
  }
  const restarted = await openBuyerIdentityState(f.environment, SCOPE, policy);
  assert.equal(
    (await restarted.evaluate({ ...input(64), owner: OWNER })).ok,
    true,
  );
  assert.equal(
    (await restarted.evaluate({ ...input(2000), owner: OWNER })).ok,
    true,
  );
  const stale = await restarted.evaluate({ ...input(0), owner: OWNER });
  assert.equal(!stale.ok && stale.code, IDENTITY_POLICY_CODES.STALE);
  const updated = await restarted.evaluate({ ...input(0, 3n), owner: OWNER });
  assert.equal(updated.ok, true);
});
void test('missing configured identities retain space at the global row bound', async (t) => {
  const f = await fixture(t, IDENTITY_STATE.maxRows - 1);
  const policy = { configuredNodeIds: [id(2000)] };
  const store = await openBuyerIdentityState(f.environment, SCOPE, policy);
  const refused = await store.evaluate(input(3000));
  assert.equal(!refused.ok && refused.code, IDENTITY_POLICY_CODES.LIMIT);
  assert.equal(
    (await store.evaluate({ ...input(2000), owner: OWNER })).ok,
    true,
  );
});
void test('two store handles cannot claim the same last global history slot', async (t) => {
  const f = await fixture(t, IDENTITY_STATE.maxRows - 1);
  const policy = { configuredNodeIds: [] };
  const a = await openBuyerIdentityState(f.environment, SCOPE, policy);
  const b = await openBuyerIdentityState(f.environment, SCOPE, policy);
  const results = await Promise.allSettled([
    a.evaluate(input(2000)),
    b.evaluate(input(2001)),
  ]);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(saved.rows.length, IDENTITY_STATE.maxRows);
  assert.equal(
    results.filter(
      (r) =>
        r.status === 'fulfilled' &&
        !r.value.ok &&
        r.value.code === IDENTITY_POLICY_CODES.OWNER_MISMATCH,
    ).length,
    1,
  );
  const reopened = await openBuyerIdentityState(f.environment, SCOPE, policy);
  const refused = await reopened.evaluate(input(2002));
  assert.equal(!refused.ok && refused.code, IDENTITY_POLICY_CODES.LIMIT);
});
void test('a capacity refusal remembers observed floors and genuine rollback remains fatal', async (t) => {
  const f = await fixture(t, IDENTITY_STATE.maxRows);
  const policy = { configuredNodeIds: [] };
  const before = await readFile(f.file, 'utf8');
  const a = await openBuyerIdentityState(f.environment, SCOPE, policy);
  const b = await openBuyerIdentityState(f.environment, SCOPE, policy);
  await a.evaluate(input(0, 2n));
  const refused = await b.evaluate(input(2000));
  assert.equal(!refused.ok && refused.code, IDENTITY_POLICY_CODES.LIMIT);
  await writeFile(f.file, before, { mode: 0o600 });
  await assert.rejects(b.evaluate(input(0)), {
    code: NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE,
  });
  await assert.rejects(b.evaluate(input(1)), {
    code: NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE,
  });
});
