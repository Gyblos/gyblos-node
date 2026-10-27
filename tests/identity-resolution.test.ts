// Read-only identity resolution uses existing signed synthetic accounts and an isolated JSON-RPC double.
// No real RPC, validator, funded wallet, keys or transaction method is used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET, FINALIZED_COMMITMENT } from '@gyblos/config';
import {
  IDENTITY_LOOKUP_FAILURES as F,
  IDENTITY_LOOKUP_KINDS as K,
} from '@gyblos/core/identity-policy';
import { resolveOwner } from '@gyblos/identity';
import {
  DEVNET_REGISTRY,
  PROGRAMS,
  READ_LIMITS,
} from '@gyblos/identity/constants';

import { addClaimant, coreAssetBytes } from './support/identity-accounts.js';
import { fixedSigner } from './support/identity-fixture.js';
import { identityResolutionFixture as fixture } from './support/identity-resolution-fixture.js';

void test('read-only resolution returns verified binding provenance using finalized reads and no writes', async () => {
  const state = await fixture();
  try {
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    const result = await readRegistryIdentity(state.rpc, state.nodeId);
    assert.deepEqual(result, {
      kind: K.BOUND,
      nodeId: state.nodeId,
      scope: {
        network: DEVNET,
        program: PROGRAMS.registry,
        collection: DEVNET_REGISTRY.collection,
      },
      binding: {
        nodeId: state.nodeId,
        owner: state.owner,
        asset: state.asset,
        sequence: 5n,
      },
    });
    assert.ok(state.state.calls.includes('getGenesisHash'));
    assert.ok(
      state.state.calls.every((method) =>
        [
          'getGenesisHash',
          'getProgramAccounts',
          'getMultipleAccounts',
        ].includes(method),
      ),
    );
    for (const call of state.state.configs.filter(
      (call) => call.method !== 'getGenesisHash',
    )) {
      const config = call.params[1];
      assert.ok(config && typeof config === 'object');
      // Kit omits finalized because it is the JSON-RPC default. Confirmed must never appear.
      assert.equal(
        'commitment' in config ? config.commitment : FINALIZED_COMMITMENT,
        FINALIZED_COMMITMENT,
      );
    }
  } finally {
    await state.close();
  }
});
void test('read-only resolution follows a higher signed owner binding and preserves legacy owner API', async () => {
  const state = await fixture();
  try {
    await addClaimant(state.chain, {
      owner: state.nextOwner,
      asset: state.nextAsset,
      node: state.node,
      sequence: 6n,
    });
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    const result = await readRegistryIdentity(state.rpc, state.nodeId);
    assert.equal(result.kind, K.BOUND);
    if (result.kind === K.BOUND) {
      assert.equal(result.binding.owner, state.nextOwner);
      assert.equal(result.binding.sequence, 6n);
    }
    assert.equal(await resolveOwner(state.rpc, state.nodeId), state.nextOwner);
  } finally {
    await state.close();
  }
});
void test('transferred Core ownership invalidates the old proof despite a stale cached registry owner', async () => {
  const state = await fixture();
  try {
    state.chain.set(state.asset, {
      owner: PROGRAMS.mplCore,
      data: coreAssetBytes(state.nextOwner),
    });
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    assert.equal(
      (await readRegistryIdentity(state.rpc, state.nodeId)).kind,
      'missing',
    );
  } finally {
    await state.close();
  }
});
void test('burned Core and deleted binding metadata are missing, not live registry identities', async () => {
  const state = await fixture();
  try {
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    state.chain.set(state.asset, {
      owner: PROGRAMS.mplCore,
      data: Uint8Array.of(0),
    });
    assert.equal(
      (await readRegistryIdentity(state.rpc, state.nodeId)).kind,
      'missing',
    );
    state.chain.set(state.asset, {
      owner: PROGRAMS.mplCore,
      data: coreAssetBytes(state.owner),
    });
    state.chain.delete(state.accounts.metadata);
    assert.equal(
      (await readRegistryIdentity(state.rpc, state.nodeId)).kind,
      'missing',
    );
  } finally {
    await state.close();
  }
});
void test('conflicting highest assets are unavailable even for one owner while legacy owner resolution stays compatible', async () => {
  const state = await fixture();
  try {
    await addClaimant(state.chain, {
      owner: state.owner,
      asset: state.nextAsset,
      node: state.node,
      sequence: 5n,
    });
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    assert.equal(
      (await readRegistryIdentity(state.rpc, state.nodeId)).kind,
      'unavailable',
    );
    assert.equal(await resolveOwner(state.rpc, state.nodeId), state.owner);
  } finally {
    await state.close();
  }
});
void test('registry genesis mismatch refuses lookup before any account scan', async () => {
  const state = await fixture();
  try {
    state.state.genesisHash = '11111111111111111111111111111111';
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    const result = await readRegistryIdentity(state.rpc, state.nodeId);
    assert.equal(result.kind, K.UNAVAILABLE);
    if (result.kind === K.UNAVAILABLE) assert.equal(result.reason, F.NETWORK);
    assert.deepEqual(state.state.calls, ['getGenesisHash']);
  } finally {
    await state.close();
  }
});
void test('RPC outages are unavailable rather than missing and never expose provider details', async () => {
  const state = await fixture();
  try {
    state.state.failingAddresses.add(state.accounts.agent);
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    const result = await readRegistryIdentity(state.rpc, state.nodeId);
    assert.equal(result.kind, K.UNAVAILABLE);
    assert.doesNotMatch(
      JSON.stringify(result),
      /synthetic outage|https?:|127\.0\.0\.1/,
    );
  } finally {
    await state.close();
  }
});
void test('claimant fan-out limit is unavailable rather than an arbitrary identity subset', async () => {
  const state = await fixture();
  try {
    for (let seed = 10; seed < 10 + READ_LIMITS.maxClaimants; seed++)
      await addClaimant(state.chain, {
        owner: state.owner,
        asset: (await fixedSigner(seed)).address,
        node: state.node,
        sequence: 1n,
      });
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    const result = await readRegistryIdentity(state.rpc, state.nodeId);
    assert.equal(result.kind, K.UNAVAILABLE);
    if (result.kind === K.UNAVAILABLE) assert.equal(result.reason, F.LIMIT);
  } finally {
    await state.close();
  }
});
void test('invalid NodeIds are rejected before any RPC call', async () => {
  const state = await fixture();
  try {
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    const result = await readRegistryIdentity(
      state.rpc,
      'PRIVATE_NON_CANONICAL_NODE',
    );
    assert.equal(result.kind, K.UNAVAILABLE);
    if (result.kind === K.UNAVAILABLE) assert.equal(result.reason, F.INVALID);
    assert.equal(state.state.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  } finally {
    await state.close();
  }
});

void test('malformed RPC account batches are unavailable and cannot create a revocation tombstone', async () => {
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
    const accepted = evaluateIdentityPolicy({
      ...input,
      lookup: await readRegistryIdentity(state.rpc, state.nodeId),
    });
    assert.equal(accepted.ok, true);
    for (const batchValue of [
      [],
      [null],
      [null, null, null, null],
      [{ owner: PROGRAMS.registry, data: ['', 'base58'] }, null, null],
      [{ owner: PROGRAMS.registry, data: ['!!!', 'base64'] }, null, null],
    ]) {
      state.state.batchValue = batchValue;
      const lookup = await readRegistryIdentity(state.rpc, state.nodeId);
      assert.equal(lookup.kind, K.UNAVAILABLE);
      const denied = evaluateIdentityPolicy({
        ...input,
        previous: accepted.state,
        lookup,
      });
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.code, C.UNAVAILABLE);
      assert.deepEqual(denied.state, accepted.state);
      assert.equal(denied.state?.revoked, false);
    }
  } finally {
    await state.close();
  }
});

void test('malformed registry scan envelopes are unavailable instead of missing identity', async () => {
  const state = await fixture();
  try {
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    for (const programValue of [
      [
        {
          pubkey: state.accounts.metadata,
          account: { owner: PROGRAMS.registry, data: ['', 'base58'] },
        },
      ],
      [
        {
          pubkey: state.accounts.metadata,
          account: { owner: PROGRAMS.registry, data: ['!!!', 'base64'] },
        },
      ],
      [
        {
          pubkey: 'PRIVATE_BAD_PUBKEY',
          account: { owner: PROGRAMS.registry, data: ['', 'base64'] },
        },
      ],
      [
        {
          pubkey: state.accounts.metadata,
          account: { owner: PROGRAMS.mplCore, data: ['', 'base64'] },
        },
      ],
      [{ pubkey: state.accounts.metadata, account: null }],
    ]) {
      state.state.programValue = programValue;
      const lookup = await readRegistryIdentity(state.rpc, state.nodeId);
      assert.equal(lookup.kind, K.UNAVAILABLE);
      assert.doesNotMatch(JSON.stringify(lookup), /PRIVATE_BAD_PUBKEY/);
    }
    state.state.programValue = [
      {
        pubkey: state.accounts.metadata,
        account: { owner: PROGRAMS.registry, data: ['', 'base64'] },
      },
    ];
    assert.equal(
      (await readRegistryIdentity(state.rpc, state.nodeId)).kind,
      K.MISSING,
    );
  } finally {
    await state.close();
  }
});
