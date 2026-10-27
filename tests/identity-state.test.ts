// Exercises durable identity floors using temporary homes and synthetic bindings only.
import assert from 'node:assert/strict';
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET, FILE_MODES } from '@gyblos/config';
import { homeLayout, ROLE_FILES } from '@gyblos/config/home';
import {
  IDENTITY_LOOKUP_KINDS,
  IDENTITY_POLICY_CODES,
  IDENTITY_TRUST_SOURCES,
  type IdentityLookup,
} from '@gyblos/core/identity-policy';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { openBuyerIdentityState } from '@gyblos/node/identity-state';
import { canonicalJson } from '@gyblos/protocol';

const scope = {
  network: DEVNET,
  program: '11111111111111111111111111111111',
  collection: '11111111111111111111111111111111',
};
const nodeId = '01'.repeat(32);
const owner = '11111111111111111111111111111111';
const otherOwner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function bound(sequence: bigint, selectedOwner = owner): IdentityLookup {
  return {
    kind: IDENTITY_LOOKUP_KINDS.BOUND,
    scope,
    nodeId,
    binding: { nodeId, owner: selectedOwner, asset: owner, sequence },
  };
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'gyblos-identity-state-')),
  );
  const environment = { GYBLOS_HOME: root, GYBLOS_LAB_HOME: join(root, 'lab') };
  const directory = homeLayout(environment).roles.buyer;
  return {
    root,
    environment,
    directory,
    path: join(directory, ROLE_FILES.identityState),
    lock: join(directory, ROLE_FILES.identityStateLock),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
void test('durable identity preserves exact u64 floors across restart and stores no content', async () => {
  const source = await fixture();
  try {
    const first = await openBuyerIdentityState(source.environment, scope);
    const sequence = 9_007_199_254_740_993n;
    assert.equal(
      (await first.evaluate({ nodeId, owner, lookup: bound(sequence) })).ok,
      true,
    );
    const second = await openBuyerIdentityState(source.environment, scope);
    const denied = await second.evaluate({
      nodeId,
      owner,
      lookup: bound(sequence - 1n),
    });
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.code, IDENTITY_POLICY_CODES.STALE);
    const bytes = await readFile(source.path, 'utf8');
    assert.ok(bytes.includes(sequence.toString()));
    assert.equal(
      (await stat(source.path)).mode & FILE_MODES.permissionMask,
      FILE_MODES.privateFile,
    );
    assert.equal(
      (await stat(source.directory)).mode & FILE_MODES.permissionMask,
      FILE_MODES.privateDirectory,
    );
  } finally {
    await source.cleanup();
  }
});
void test('denied owner rotation is persisted and cannot roll back after restart', async () => {
  const source = await fixture();
  try {
    const store = await openBuyerIdentityState(source.environment, scope);
    await store.evaluate({ nodeId, owner, lookup: bound(1n) });
    const rotated = await store.evaluate({
      nodeId,
      owner,
      lookup: bound(2n, otherOwner),
    });
    assert.equal(
      !rotated.ok && rotated.code,
      IDENTITY_POLICY_CODES.OWNER_CHANGED,
    );
    const restarted = await openBuyerIdentityState(source.environment, scope);
    const denied = await restarted.evaluate({
      nodeId,
      owner,
      lookup: bound(1n),
    });
    assert.equal(!denied.ok && denied.code, IDENTITY_POLICY_CODES.STALE);
    assert.equal(
      (
        await restarted.evaluate({
          nodeId,
          owner: otherOwner,
          lookup: bound(2n, otherOwner),
        })
      ).ok,
      true,
    );
  } finally {
    await source.cleanup();
  }
});
void test('durable tombstone survives manual override and its removal across restart', async () => {
  const source = await fixture();
  try {
    const store = await openBuyerIdentityState(source.environment, scope);
    await store.evaluate({ nodeId, owner, lookup: bound(3n) });
    const missing: IdentityLookup = {
      kind: IDENTITY_LOOKUP_KINDS.MISSING,
      scope,
      nodeId,
    };
    assert.equal(
      (await store.evaluate({ nodeId, owner, lookup: missing })).ok,
      false,
    );
    const manual = await store.evaluate({
      nodeId,
      owner,
      manual: { nodeId, owner },
    });
    assert.equal(manual.ok && manual.source, IDENTITY_TRUST_SOURCES.MANUAL);
    const restarted = await openBuyerIdentityState(source.environment, scope);
    const denied = await restarted.evaluate({
      nodeId,
      owner,
      lookup: bound(3n),
    });
    assert.equal(!denied.ok && denied.code, IDENTITY_POLICY_CODES.REVOKED);
    assert.equal(
      (await restarted.evaluate({ nodeId, owner, lookup: bound(4n) })).ok,
      true,
    );
  } finally {
    await source.cleanup();
  }
});
void test('two live stores re-read the shared floor and a missing state fails closed', async () => {
  const source = await fixture();
  try {
    const first = await openBuyerIdentityState(source.environment, scope);
    const second = await openBuyerIdentityState(source.environment, scope);
    await first.evaluate({ nodeId, owner, lookup: bound(9n) });
    const denied = await second.evaluate({ nodeId, owner, lookup: bound(8n) });
    assert.equal(!denied.ok && denied.code, IDENTITY_POLICY_CODES.STALE);
    await rm(source.path);
    await assert.rejects(
      second.evaluate({ nodeId, owner, manual: { nodeId, owner } }),
      { code: NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE },
    );
  } finally {
    await source.cleanup();
  }
});
void test('held lock fails closed and never deletes a foreign lock', async () => {
  const source = await fixture();
  try {
    const store = await openBuyerIdentityState(source.environment, scope);
    await writeFile(source.lock, 'foreign', { mode: FILE_MODES.privateFile });
    await assert.rejects(store.evaluate({ nodeId, owner, lookup: bound(1n) }), {
      code: NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE,
    });
    assert.equal(await readFile(source.lock, 'utf8'), 'foreign');
  } finally {
    await source.cleanup();
  }
});
for (const corruption of [
  'unknown field',
  'noncanonical sequence',
  'duplicate node',
  'wrong scope',
  'permissive',
  'symlink',
  'hardlink',
]) {
  void test(`durable identity rejects ${corruption} without repairing the file`, async () => {
    const source = await fixture();
    try {
      const store = await openBuyerIdentityState(source.environment, scope);
      await store.evaluate({ nodeId, owner, lookup: bound(1n) });
      const text = await readFile(source.path, 'utf8');
      const value = JSON.parse(text);
      if (corruption === 'unknown field') value.extra = true;
      if (corruption === 'noncanonical sequence')
        value.rows[0].binding.sequence = '01';
      if (corruption === 'duplicate node') value.rows.push(value.rows[0]);
      if (corruption === 'wrong scope') value.scope.collection = otherOwner;
      if (
        [
          'unknown field',
          'noncanonical sequence',
          'duplicate node',
          'wrong scope',
        ].includes(corruption)
      )
        await writeFile(source.path, canonicalJson(value));
      if (corruption === 'permissive') await chmod(source.path, 0o644);
      if (corruption === 'symlink') {
        await rm(source.path);
        await writeFile(join(source.root, 'target'), text);
        await symlink(join(source.root, 'target'), source.path);
      }
      if (corruption === 'hardlink')
        await link(source.path, join(source.root, 'linked'));
      await assert.rejects(openBuyerIdentityState(source.environment, scope), {
        code: NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE,
      });
    } finally {
      await source.cleanup();
    }
  });
}

void test('live instances accept strengthening tombstones and never clear them at the same sequence', async () => {
  const source = await fixture();
  try {
    const first = await openBuyerIdentityState(source.environment, scope);
    const second = await openBuyerIdentityState(source.environment, scope);
    await first.evaluate({ nodeId, owner, lookup: bound(2n) });
    await second.evaluate({ nodeId, owner, lookup: bound(2n) });
    await first.evaluate({
      nodeId,
      owner,
      lookup: { kind: IDENTITY_LOOKUP_KINDS.MISSING, scope, nodeId },
    });
    const denied = await second.evaluate({ nodeId, owner, lookup: bound(2n) });
    assert.equal(!denied.ok && denied.code, IDENTITY_POLICY_CODES.REVOKED);
  } finally {
    await source.cleanup();
  }
});
void test('identity state never evicts old nodes when its bounded table is full', async () => {
  const source = await fixture();
  try {
    const { IDENTITY_STATE } = await import('@gyblos/node/constants');
    await openBuyerIdentityState(source.environment, scope);
    const rows = Array.from({ length: IDENTITY_STATE.maxRows }, (_, index) => ({
      binding: {
        nodeId: index.toString(16).padStart(64, '0'),
        owner,
        asset: owner,
        sequence: '1',
      },
      revoked: false,
    }));
    await writeFile(
      source.path,
      canonicalJson({
        schemaVersion: IDENTITY_STATE.schemaVersion,
        scope,
        rows,
      }),
      { mode: FILE_MODES.privateFile },
    );
    const store = await openBuyerIdentityState(source.environment, scope);
    const before = await readFile(source.path, 'utf8');
    await assert.rejects(store.evaluate({ nodeId, owner, lookup: bound(1n) }), {
      code: NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE,
    });
    assert.equal(await readFile(source.path, 'utf8'), before);
  } finally {
    await source.cleanup();
  }
});

void test('one identity store serializes concurrent decisions without losing floors', async () => {
  const source = await fixture();
  try {
    const store = await openBuyerIdentityState(source.environment, scope);
    const results = await Promise.all(
      [1n, 2n, 3n].map((sequence) =>
        store.evaluate({ nodeId, owner, lookup: bound(sequence) }),
      ),
    );
    assert.ok(results.every((result) => result.ok));
    const restarted = await openBuyerIdentityState(source.environment, scope);
    const denied = await restarted.evaluate({
      nodeId,
      owner,
      lookup: bound(2n),
    });
    assert.equal(!denied.ok && denied.code, IDENTITY_POLICY_CODES.STALE);
  } finally {
    await source.cleanup();
  }
});
void test('identity store refuses oversized metadata before parsing it', async () => {
  const source = await fixture();
  try {
    const { IDENTITY_STATE } = await import('@gyblos/node/constants');
    await openBuyerIdentityState(source.environment, scope);
    await writeFile(source.path, ' '.repeat(IDENTITY_STATE.maxBytes + 1), {
      mode: FILE_MODES.privateFile,
    });
    await assert.rejects(openBuyerIdentityState(source.environment, scope), {
      code: NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE,
    });
  } finally {
    await source.cleanup();
  }
});
void test('identity store refuses a symlinked product-home ancestor without creating role state', async () => {
  const source = await fixture();
  try {
    const alias = join(source.root, 'alias');
    await symlink(source.root, alias);
    await assert.rejects(
      openBuyerIdentityState({ GYBLOS_HOME: alias }, scope),
      { code: NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE },
    );
    await assert.rejects(stat(source.directory), { code: 'ENOENT' });
  } finally {
    await source.cleanup();
  }
});
