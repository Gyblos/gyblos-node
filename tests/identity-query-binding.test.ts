// Exercises pure owner/NodeId trust decisions with synthetic addresses and caller-owned observations.
// No RPC, adapter, clock, filesystem, registration or payment service is created.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET, DEVNET_USDC, SYSTEM_PROGRAM_ADDRESS } from '@gyblos/config';

const NODE_ID = 'ab'.repeat(32);
const OTHER_NODE_ID = 'cd'.repeat(32);
const OWNER = '11111111111111111111111111111111';
const ASSET = DEVNET_USDC;
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

void test('foreign missing observations cannot revoke another NodeId', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  const result = evaluateIdentityPolicy({
    ...target,
    previous,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.MISSING,
      nodeId: OTHER_NODE_ID,
      scope,
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.SCOPE);
  assert.deepEqual(result.state, previous);
});
void test('bound observation query and binding must target the same NodeId', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
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
  if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.SCOPE);
  assert.deepEqual(result.state, previous);
});
void test('foreign unavailable observations cannot be applied to another NodeId', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_LOOKUP_FAILURES,
    IDENTITY_POLICY_CODES,
  } = await api();
  const result = evaluateIdentityPolicy({
    ...target,
    previous,
    lookup: {
      kind: IDENTITY_LOOKUP_KINDS.UNAVAILABLE,
      nodeId: OTHER_NODE_ID,
      scope,
      reason: IDENTITY_LOOKUP_FAILURES.TIMEOUT,
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.SCOPE);
  assert.deepEqual(result.state, previous);
});
void test('invalid query observations use a null NodeId without erasing state', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_LOOKUP_FAILURES,
    IDENTITY_POLICY_CODES,
  } = await api();
  for (const reason of Object.values(IDENTITY_LOOKUP_FAILURES)) {
    const result = evaluateIdentityPolicy({
      ...target,
      previous,
      lookup: {
        kind: IDENTITY_LOOKUP_KINDS.UNAVAILABLE,
        nodeId: null,
        scope,
        reason,
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.INVALID);
    assert.deepEqual(result.state, previous);
  }
});

void test('identity lookup discriminators are rejected without invoking accessors', async () => {
  const {
    evaluateIdentityPolicy,
    IDENTITY_LOOKUP_KINDS,
    IDENTITY_POLICY_CODES,
  } = await api();
  let reads = 0;
  const lookup = {
    get kind() {
      reads++;
      return IDENTITY_LOOKUP_KINDS.BOUND;
    },
    scope,
    binding,
  };
  const result = evaluateIdentityPolicy({ ...target, previous, lookup });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, IDENTITY_POLICY_CODES.INVALID);
  assert.equal(reads, 0);
  assert.deepEqual(result.state, previous);
});
