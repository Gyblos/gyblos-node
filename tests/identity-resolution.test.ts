// Read-only identity resolution uses existing signed synthetic accounts and an isolated JSON-RPC double.
// No real RPC, validator, funded wallet, keys or transaction method is used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET, FINALIZED_COMMITMENT } from '@gyblos/config';
import { resolveOwner } from '@gyblos/identity';
import { nodeIdFromAddress } from '@gyblos/identity/codec';
import {
  DEVNET_REGISTRY,
  PROGRAMS,
  READ_LIMITS,
} from '@gyblos/identity/constants';

import {
  addClaimant,
  coreAssetBytes,
  type SyntheticChain,
} from './support/identity-accounts.js';
import { fixedSigner } from './support/identity-fixture.js';
import { startFakeRpc } from './support/identity-rpc-fake.js';

async function fixture() {
  const node = await fixedSigner(1);
  const owner = (await fixedSigner(2)).address;
  const asset = (await fixedSigner(3)).address;
  const nextOwner = (await fixedSigner(4)).address;
  const nextAsset = (await fixedSigner(5)).address;
  const chain: SyntheticChain = new Map();
  const accounts = await addClaimant(chain, {
    owner,
    asset,
    node,
    sequence: 5n,
  });
  const fake = await startFakeRpc(chain);
  return {
    ...fake,
    node,
    owner,
    asset,
    nextOwner,
    nextAsset,
    accounts,
    chain,
    nodeId: nodeIdFromAddress(node.address),
  };
}
void test('read-only resolution returns verified binding provenance using finalized reads and no writes', async () => {
  const state = await fixture();
  try {
    const { readRegistryIdentity } =
      await import('@gyblos/identity/resolution');
    const result = await readRegistryIdentity(state.rpc, state.nodeId);
    assert.deepEqual(result, {
      kind: 'bound',
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
    ))
      {
        const config = call.params[1];
        assert.ok(config && typeof config === 'object' && 'commitment' in config);
        assert.equal(config.commitment, FINALIZED_COMMITMENT);
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
    assert.equal(result.kind, 'bound');
    if (result.kind === 'bound') {
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
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.reason, 'network');
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
    assert.equal(result.kind, 'unavailable');
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
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.reason, 'limit');
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
    assert.equal(result.kind, 'unavailable');
    if (result.kind === 'unavailable') assert.equal(result.reason, 'invalid');
    assert.equal(state.state.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  } finally {
    await state.close();
  }
});
