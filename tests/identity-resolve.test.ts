// Owns offline NodeId → owner resolution cases over a loopback JSON-RPC double: the highest signed sequence
// wins, legacy v1 bindings count as sequence 0, foreign NodeIds never resolve, and fan-out is capped and batched.
// Synthetic accounts and fixed synthetic signers only; no network or funded wallets.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner, type Address } from '@solana/kit';

import {
  IDENTITY_ERROR_CODES,
  IdentityError,
  METADATA_KEYS,
  readNodeIdentity,
  resolveOwner,
  type IdentityErrorCode,
} from '@gyblos/identity';
import {
  encodeBindingValue,
  nodeIdFromAddress,
  signNodeBinding,
} from '@gyblos/identity/codec';
import { PROGRAMS, READ_LIMITS } from '@gyblos/identity/constants';

import {
  addClaimant,
  metadataBytes,
  type SyntheticChain,
} from './support/identity-accounts.js';
import { fixedSigner } from './support/identity-fixture.js';
import { startFakeRpc, type FakeRpc } from './support/identity-rpc-fake.js';

// Historical v1 gyblos.nodeId value signed by fixedSigner(1) for asset fixedSigner(3), owner fixedSigner(2).
const LEGACY_V1_VALUE =
  '018a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c617adeb78270c24eddef9b152c674def59c8d277be4e66846358e46b2b4694f05f755e8a415607f6ff6766abde93024583a70bd37bf4e8060c1c45befe590204';
const MULTIPLE_ACCOUNTS = 'getMultipleAccounts';

async function keys() {
  return {
    node: await fixedSigner(1),
    firstOwner: (await fixedSigner(2)).address,
    firstAsset: (await fixedSigner(3)).address,
    secondOwner: (await fixedSigner(4)).address,
    secondAsset: (await fixedSigner(5)).address,
    otherNode: await fixedSigner(6),
  };
}

type Keys = Awaited<ReturnType<typeof keys>>;

async function withRpc<T>(
  chain: SyntheticChain,
  run: (fake: FakeRpc) => Promise<T>,
): Promise<T> {
  const fake = await startFakeRpc(chain);
  try {
    return await run(fake);
  } finally {
    await fake.close();
  }
}

function hasCode(code: IdentityErrorCode) {
  return (error: unknown) =>
    error instanceof IdentityError && error.code === code;
}

function nodeIdOf(k: Keys): string {
  return nodeIdFromAddress(k.node.address);
}

function countCalls(fake: FakeRpc, method: string): number {
  return fake.state.calls.filter((call) => call === method).length;
}

async function firstAndSecond(
  chain: SyntheticChain,
  k: Keys,
  sequences: { first: bigint; second: bigint },
) {
  await addClaimant(chain, {
    owner: k.firstOwner,
    asset: k.firstAsset,
    node: k.node,
    sequence: sequences.first,
  });
  await addClaimant(chain, {
    owner: k.secondOwner,
    asset: k.secondAsset,
    node: k.node,
    sequence: sequences.second,
  });
}

// count claimants for one node with fresh owners and assets, all at sequence 1.
async function addManyClaimants(
  chain: SyntheticChain,
  node: Keys['node'],
  count: number,
  owner?: Address,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await addClaimant(chain, {
      owner: owner ?? (await generateKeyPairSigner()).address,
      asset: (await generateKeyPairSigner()).address,
      node,
    });
  }
}

void test('a rebinding signed with a higher sequence moves the NodeId to the new owner', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await firstAndSecond(chain, k, { first: 1n, second: 2n });
  await withRpc(chain, async ({ rpc }) => {
    assert.equal(await resolveOwner(rpc, nodeIdOf(k)), k.secondOwner);
  });
});

void test('the old owner replaying its earlier binding stays outranked', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await firstAndSecond(chain, k, { first: 5n, second: 6n });
  // The old owner copies its sequence-5 binding bytes onto a fresh asset it owns: wrong asset, invalid.
  const replayAsset = (await fixedSigner(7)).address;
  const oldBinding = encodeBindingValue(
    await signNodeBinding(k.node, {
      asset: k.firstAsset,
      owner: k.firstOwner,
      sequence: 5n,
    }),
  );
  await addClaimant(chain, {
    owner: k.firstOwner,
    asset: replayAsset,
    node: k.node,
    bindingValue: oldBinding,
  });
  await withRpc(chain, async ({ rpc }) => {
    assert.equal(await resolveOwner(rpc, nodeIdOf(k)), k.secondOwner);
  });
});

void test('equal highest sequences on different owners are ambiguous even above a lower claim', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await firstAndSecond(chain, k, { first: 3n, second: 3n });
  await addClaimant(chain, {
    owner: (await fixedSigner(8)).address,
    asset: (await fixedSigner(9)).address,
    node: k.node,
    sequence: 2n,
  });
  await withRpc(chain, async ({ rpc }) => {
    await assert.rejects(
      resolveOwner(rpc, nodeIdOf(k)),
      hasCode(IDENTITY_ERROR_CODES.NODE_ID_AMBIGUOUS),
    );
  });
});

void test('a legacy v1 binding resolves as sequence 0 and any v2 rebinding outranks it', async () => {
  const k = await keys();
  const legacy = {
    owner: k.firstOwner,
    asset: k.firstAsset,
    node: k.node,
    bindingValue: new Uint8Array(Buffer.from(LEGACY_V1_VALUE, 'hex')),
  };
  const alone: SyntheticChain = new Map();
  await addClaimant(alone, legacy);
  await withRpc(alone, async ({ rpc }) => {
    assert.equal(await resolveOwner(rpc, nodeIdOf(k)), k.firstOwner);
    assert.equal(
      (await readNodeIdentity(rpc, { asset: k.firstAsset }))?.bindingSequence,
      0n,
    );
  });
  const rebound: SyntheticChain = new Map();
  await addClaimant(rebound, legacy);
  await addClaimant(rebound, {
    owner: k.secondOwner,
    asset: k.secondAsset,
    node: k.node,
    sequence: 1n,
  });
  await withRpc(rebound, async ({ rpc }) => {
    assert.equal(await resolveOwner(rpc, nodeIdOf(k)), k.secondOwner);
  });
});

void test('a claimant whose verified binding names a different NodeId never resolves', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  // The asset's real metadata PDA validly binds otherNode.
  await addClaimant(chain, {
    owner: k.firstOwner,
    asset: k.firstAsset,
    node: k.otherNode,
  });
  // A stray registry account (as a lying RPC might return) carries k.node's prefix for that asset.
  const stray = encodeBindingValue(
    await signNodeBinding(k.node, {
      asset: k.firstAsset,
      owner: k.firstOwner,
      sequence: 1n,
    }),
  );
  chain.set((await fixedSigner(10)).address, {
    owner: PROGRAMS.registry,
    data: metadataBytes(k.firstAsset, METADATA_KEYS.nodeId, stray),
  });
  await withRpc(chain, async ({ rpc }) => {
    assert.equal(await resolveOwner(rpc, nodeIdOf(k)), undefined);
  });
});

void test('claimants up to the cap are read in one batched getMultipleAccounts call', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await addManyClaimants(chain, k.node, READ_LIMITS.maxClaimants - 1);
  await addClaimant(chain, {
    owner: k.firstOwner,
    asset: k.firstAsset,
    node: k.node,
    sequence: 9n,
  });
  await withRpc(chain, async (fake) => {
    assert.equal(await resolveOwner(fake.rpc, nodeIdOf(k)), k.firstOwner);
    assert.equal(countCalls(fake, MULTIPLE_ACCOUNTS), 1);
  });
});

void test('more claimants than the cap throw TOO_MANY_CLAIMANTS before reading any of them', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await addManyClaimants(chain, k.node, READ_LIMITS.maxClaimants + 1);
  await withRpc(chain, async (fake) => {
    await assert.rejects(
      resolveOwner(fake.rpc, nodeIdOf(k)),
      hasCode(IDENTITY_ERROR_CODES.TOO_MANY_CLAIMANTS),
    );
    assert.equal(countCalls(fake, MULTIPLE_ACCOUNTS), 0);
  });
});

void test('reading by owner is capped and batched the same way', async () => {
  const k = await keys();
  const atCap: SyntheticChain = new Map();
  await addManyClaimants(atCap, k.node, READ_LIMITS.maxClaimants, k.firstOwner);
  await withRpc(atCap, async (fake) => {
    const owned = await readNodeIdentity(fake.rpc, { owner: k.firstOwner });
    assert.equal(owned.length, READ_LIMITS.maxClaimants);
    assert.equal(countCalls(fake, MULTIPLE_ACCOUNTS), 1);
  });
  await addManyClaimants(atCap, k.node, 1, k.firstOwner);
  await withRpc(atCap, async (fake) => {
    await assert.rejects(
      readNodeIdentity(fake.rpc, { owner: k.firstOwner }),
      hasCode(IDENTITY_ERROR_CODES.TOO_MANY_CLAIMANTS),
    );
    assert.equal(countCalls(fake, MULTIPLE_ACCOUNTS), 0);
  });
});
