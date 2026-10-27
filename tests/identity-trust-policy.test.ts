// Exercises pure owner/NodeId trust decisions with synthetic addresses and caller-owned observations.
// No RPC, adapter, clock, filesystem, registration or payment service is created.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET, DEVNET_USDC, SYSTEM_PROGRAM_ADDRESS } from '@gyblos/config';

const NODE_ID = 'ab'.repeat(32);
const OTHER_NODE_ID = 'cd'.repeat(32);
const OWNER = '11111111111111111111111111111111';
const NEW_OWNER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSET = DEVNET_USDC;
const OTHER_ASSET = 'BPFLoaderUpgradeab1e11111111111111111111111';
const scope = {
  network: DEVNET,
  program: SYSTEM_PROGRAM_ADDRESS,
  collection: DEVNET_USDC,
};
const binding = { nodeId: NODE_ID, owner: OWNER, asset: ASSET, sequence: 1n };
const previous = { scope, binding, revoked: false };
const target = { nodeId: NODE_ID, owner: OWNER, scope };
async function api() {
  return import('@gyblos/core/identity-policy');
}

void test('registry policy accepts one verified scoped binding and returns detached state', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_TRUST_SOURCES,
  } = await api();
  const result = evaluateIdentityPolicy({
    ...target,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding,
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, IDENTITY_TRUST_SOURCES.REGISTRY);
  assert.deepEqual(result.state, previous);
  assert.notEqual(result.state?.binding, binding);
});
void test('registry owner rotation advances the floor even when the old owner is rejected', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  const rotated = {
    ...binding,
    owner: NEW_OWNER,
    asset: OTHER_ASSET,
    sequence: 2n,
  };
  const result = evaluateIdentityPolicy({
    ...target,
    previous,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding: rotated,
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, IDENTITY_POLICY_CODES.OWNER_CHANGED);
  assert.deepEqual(result.state?.binding, rotated);
  const accepted = evaluateIdentityPolicy({
    ...target,
    owner: NEW_OWNER,
    previous: result.state,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding: rotated,
    },
  });
  assert.equal(accepted.ok, true);
  const replayed = evaluateIdentityPolicy({
    ...target,
    previous: result.state,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding,
    },
  });
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.equal(replayed.code, IDENTITY_POLICY_CODES.STALE);
  assert.deepEqual(replayed.state, result.state);
});
void test('registry owner mismatch never grants trust without a configured matching owner', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  const result = evaluateIdentityPolicy({
    ...target,
    owner: NEW_OWNER,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding,
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.code, IDENTITY_POLICY_CODES.OWNER_MISMATCH);
  assert.deepEqual(result.state, previous);
});
void test('missing binding creates a tombstone and a strictly newer binding alone restores it', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  const absent = evaluateIdentityPolicy({
    ...target,
    previous,
    lookup: { kind: IDENTITY_LOOKUP_KINDS.MISSING, nodeId: NODE_ID, scope },
  });
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.code, IDENTITY_POLICY_CODES.REVOKED);
  assert.deepEqual(absent.state, { ...previous, revoked: true });
  const replay = evaluateIdentityPolicy({
    ...target,
    previous: absent.state,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding,
    },
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.code, IDENTITY_POLICY_CODES.REVOKED);
  const fresh = evaluateIdentityPolicy({
    ...target,
    previous: absent.state,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding: { ...binding, sequence: 2n },
    },
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.state?.revoked, false);
});
void test('an unknown NodeId with no binding is not found rather than revoked or trusted', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  const result = evaluateIdentityPolicy({
    ...target,
    lookup: { kind: IDENTITY_LOOKUP_KINDS.MISSING, nodeId: NODE_ID, scope },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.NOT_FOUND);
  assert.equal(result.state, undefined);
});
void test('equal sequence with another owner or asset is a conflict and preserves the floor', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  for (const changed of [{ owner: NEW_OWNER }, { asset: OTHER_ASSET }]) {
    const result = evaluateIdentityPolicy({
      ...target,
      previous,
      lookup: {
        kind: IDENTITY_LOOKUP_KINDS.BOUND,
        nodeId: NODE_ID,
        scope,
        binding: { ...binding, ...changed },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.CONFLICT);
    assert.deepEqual(result.state, previous);
  }
});
void test('an explicit matching manual override bypasses registry failure while preserving its tombstone', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_LOOKUP_FAILURES,
    IDENTITY_TRUST_SOURCES,
  } = await api();
  const tombstone = { ...previous, revoked: true };
  const result = evaluateIdentityPolicy({
    ...target,
    previous: tombstone,
    manual: { nodeId: NODE_ID, owner: OWNER },
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.UNAVAILABLE,
      nodeId: NODE_ID,
      scope,
      reason: IDENTITY_LOOKUP_FAILURES.UNAVAILABLE,
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.source, IDENTITY_TRUST_SOURCES.MANUAL);
  assert.deepEqual(result.state, tombstone);
  const restored = evaluateIdentityPolicy({
    ...target,
    previous: result.state,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding,
    },
  });
  assert.equal(restored.ok, false);
});
void test('manual mismatch never silently falls back to a registry match', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  const result = evaluateIdentityPolicy({
    ...target,
    previous,
    manual: { nodeId: NODE_ID, owner: NEW_OWNER },
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding,
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.code, IDENTITY_POLICY_CODES.OWNER_MISMATCH);
  assert.deepEqual(result.state, previous);
});
void test('registry failures remain static denials and never erase known state or act as revocation', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_LOOKUP_FAILURES,
  } = await api();
  for (const reason of Object.values(IDENTITY_LOOKUP_FAILURES)) {
    const result = evaluateIdentityPolicy({
      ...target,
      previous,
      lookup: {
        kind: IDENTITY_LOOKUP_KINDS.UNAVAILABLE,
        nodeId: NODE_ID,
        scope,
        reason,
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.state, previous);
    assert.doesNotMatch(
      JSON.stringify(result, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
      /https?:|PRIVATE/,
    );
  }
});
void test('registry context or NodeId mismatches cannot mix trust histories', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  for (const changedScope of [
    { ...scope, collection: OTHER_ASSET },
    { ...scope, program: OTHER_ASSET },
    { ...scope, network: 'solana:other' },
  ]) {
    const result = evaluateIdentityPolicy({
      ...target,
      previous,
      lookup: {
        kind: IDENTITY_LOOKUP_KINDS.BOUND,
        nodeId: NODE_ID,
        scope: changedScope,
        binding,
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.SCOPE);
    assert.deepEqual(result.state, previous);
  }
  const result = evaluateIdentityPolicy({
    ...target,
    previous,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding: { ...binding, nodeId: OTHER_NODE_ID },
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.state, previous);
});
void test('identity policy rejects unknown fields, noncanonical keys, invalid sequences and lookup reasons', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  const valid = {
    ...target,
    previous,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.BOUND,
      nodeId: NODE_ID,
      scope,
      binding,
    },
  };
  for (const value of [
    { ...valid, extra: 'PRIVATE' },
    { ...valid, nodeId: NODE_ID.toUpperCase() },
    { ...valid, owner: 'PRIVATE' },
    { ...valid, lookup: { ...valid.lookup, extra: 'PRIVATE' } },
    {
      ...valid,
      lookup: { ...valid.lookup, binding: { ...binding, sequence: -1n } },
    },
    {
      ...valid,
      lookup: {
        ...valid.lookup,
        binding: { ...binding, sequence: 0x1_0000_0000_0000_0000n },
      },
    },
    {
      ...valid,
      lookup: { ...valid.lookup, binding: { ...binding, sequence: '1' } },
    },
    { ...valid, lookup: { kind: 'unavailable', scope, reason: 'PRIVATE' } },
  ]) {
    const result = evaluateIdentityPolicy(value);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.INVALID);
  }
});
void test('manual overrides require no registry observation and return detached stable state', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_TRUST_SOURCES,
    IDENTITY_POLICY_CODES,
  } = await api();
  const result = evaluateIdentityPolicy({
    ...target,
    previous,
    manual: { nodeId: NODE_ID, owner: OWNER },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.source, IDENTITY_TRUST_SOURCES.MANUAL);
  assert.deepEqual(result.state, previous);
  assert.notEqual(result.state, previous);
  const unavailable = evaluateIdentityPolicy({ ...target, previous });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok)
    assert.equal(unavailable.code, IDENTITY_POLICY_CODES.UNAVAILABLE);
  assert.deepEqual(unavailable.state, previous);
});
