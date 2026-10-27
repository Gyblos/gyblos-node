// Verifies adapter observations feed the pure identity policy without rewriting registry history.
// Only signed synthetic accounts and local RPC are used; state stays in memory.
import assert from 'node:assert/strict';
import test from 'node:test';

import { addClaimant } from './support/identity-accounts.js';
import { identityResolutionFixture as fixture } from './support/identity-resolution-fixture.js';

void test('verified owner rotation advances policy state and prevents fallback when the newest claim disappears', async () => {
  const state = await fixture();
  try {
    const { readRegistryIdentity, IDENTITY_RESOLUTION_SCOPE } =
      await import('@gyblos/identity/resolution');
    const { evaluateIdentityPolicy, IDENTITY_POLICY_CODES: C } =
      await import('@gyblos/core/identity-policy');
    const input = {
      nodeId: state.nodeId,
      owner: state.owner,
      scope: IDENTITY_RESOLUTION_SCOPE,
    };
    const first = evaluateIdentityPolicy({
      ...input,
      lookup: await readRegistryIdentity(state.rpc, state.nodeId),
    });
    assert.equal(first.ok, true);
    const next = await addClaimant(state.chain, {
      owner: state.nextOwner,
      asset: state.nextAsset,
      node: state.node,
      sequence: 6n,
    });
    const rotated = evaluateIdentityPolicy({
      ...input,
      previous: first.state,
      lookup: await readRegistryIdentity(state.rpc, state.nodeId),
    });
    assert.equal(rotated.ok, false);
    if (!rotated.ok) assert.equal(rotated.code, C.OWNER_CHANGED);
    assert.equal(rotated.state?.binding.sequence, 6n);
    state.chain.delete(next.metadata);
    const rollback = evaluateIdentityPolicy({
      ...input,
      previous: rotated.state,
      lookup: await readRegistryIdentity(state.rpc, state.nodeId),
    });
    assert.equal(rollback.ok, false);
    if (!rollback.ok) assert.equal(rollback.code, C.STALE);
    assert.equal(rollback.state?.binding.owner, state.nextOwner);
  } finally {
    await state.close();
  }
});
void test('missing registry binding becomes a tombstone that survives explicit manual override and its removal', async () => {
  const state = await fixture();
  try {
    const { readRegistryIdentity, IDENTITY_RESOLUTION_SCOPE } =
      await import('@gyblos/identity/resolution');
    const {
      evaluateIdentityPolicy,
      IDENTITY_POLICY_CODES: C,
      IDENTITY_TRUST_SOURCES: S,
    } = await import('@gyblos/core/identity-policy');
    const input = {
      nodeId: state.nodeId,
      owner: state.owner,
      scope: IDENTITY_RESOLUTION_SCOPE,
    };
    const first = evaluateIdentityPolicy({
      ...input,
      lookup: await readRegistryIdentity(state.rpc, state.nodeId),
    });
    const metadata = state.chain.get(state.accounts.metadata)!;
    state.chain.delete(state.accounts.metadata);
    const revoked = evaluateIdentityPolicy({
      ...input,
      previous: first.state,
      lookup: await readRegistryIdentity(state.rpc, state.nodeId),
    });
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.code, C.REVOKED);
    const count = state.state.calls.length;
    const manual = evaluateIdentityPolicy({
      ...input,
      previous: revoked.state,
      manual: { nodeId: state.nodeId, owner: state.owner },
    });
    assert.equal(manual.ok, true);
    if (manual.ok) assert.equal(manual.source, S.MANUAL);
    assert.equal(state.state.calls.length, count);
    assert.equal(manual.state?.revoked, true);
    state.chain.set(state.accounts.metadata, metadata);
    const restored = evaluateIdentityPolicy({
      ...input,
      previous: manual.state,
      lookup: await readRegistryIdentity(state.rpc, state.nodeId),
    });
    assert.equal(restored.ok, false);
    if (!restored.ok) assert.equal(restored.code, C.REVOKED);
  } finally {
    await state.close();
  }
});
