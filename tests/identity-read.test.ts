// Owns offline identity read regression cases over synthetic accounts served by a loopback JSON-RPC double:
// per-claimant resolution, collection check, metadata cross-check and account-owner checks. No network or keys.
import assert from 'node:assert/strict';
import test from 'node:test';

import { address, isSolanaError } from '@solana/kit';

import {
  BINDING_STATUSES,
  COLLECTION_POLICY,
  IDENTITY_ERROR_CODES,
  IdentityError,
  METADATA_KEYS,
  readNodeIdentity,
  resolveOwner,
  type IdentityErrorCode,
} from '@gyblos/identity';
import { encodeBindingValue, signNodeBinding } from '@gyblos/identity/binding';
import { PROGRAMS } from '@gyblos/identity/constants';

import {
  addClaimant,
  burnedCoreAssetBytes,
  metadataBytes,
  type ClaimantAddresses,
  type SyntheticChain,
} from './support/identity-accounts.js';
import { fixedSigner } from './support/identity-fixture.js';
import { startFakeRpc, type FakeRpc } from './support/identity-rpc-fake.js';

const OTHER_COLLECTION = address('KmqkyFGfhrwu1gm1HjgkQGW61mecANEAjMGz8H51wWK');

async function keys() {
  return {
    node: await fixedSigner(1),
    honestOwner: (await fixedSigner(2)).address,
    honestAsset: (await fixedSigner(3)).address,
    rivalOwner: (await fixedSigner(4)).address,
    rivalAsset: (await fixedSigner(5)).address,
  };
}

type Keys = Awaited<ReturnType<typeof keys>>;

// Honest claimant plus a rival claimant whose accounts each test then breaks.
async function honestAndRival(chain: SyntheticChain, k: Keys) {
  await addClaimant(chain, {
    owner: k.honestOwner,
    asset: k.honestAsset,
    node: k.node,
  });
  return addClaimant(chain, {
    owner: k.rivalOwner,
    asset: k.rivalAsset,
    node: k.node,
  });
}

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

async function nodeIdOf(k: Keys): Promise<string> {
  return (await signNodeBinding(k.node, k.honestAsset, k.honestOwner)).nodeId;
}

void test('two valid owners for one NodeId stay ambiguous', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await honestAndRival(chain, k);
  await withRpc(chain, async ({ rpc }) => {
    await assert.rejects(
      resolveOwner(rpc, await nodeIdOf(k)),
      hasCode(IDENTITY_ERROR_CODES.NODE_ID_AMBIGUOUS),
    );
  });
});

void test('a claimant whose Core asset is a burned 1-byte stub cannot block the honest owner', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  const rival = await honestAndRival(chain, k);
  chain.set(rival.core, {
    owner: PROGRAMS.mplCore,
    data: burnedCoreAssetBytes(),
  });
  await withRpc(chain, async ({ rpc }) => {
    assert.equal(await resolveOwner(rpc, await nodeIdOf(k)), k.honestOwner);
    await assert.rejects(
      readNodeIdentity(rpc, { asset: k.rivalAsset }),
      hasCode(IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID),
    );
  });
});

void test('claimants with undecodable, foreign-owned or missing accounts are non-matching', async () => {
  const k = await keys();
  type Breakage = (chain: SyntheticChain, rival: ClaimantAddresses) => void;
  const breakages: Breakage[] = [
    // Agent PDA with garbage bytes, then no agent PDA at all.
    (chain, rival) =>
      chain.set(rival.agent, {
        owner: PROGRAMS.registry,
        data: new Uint8Array(9),
      }),
    (chain, rival) => chain.delete(rival.agent),
    // Core asset owned by another program, then a Core account with a non-AssetV1 key.
    (chain, rival) =>
      chain.set(rival.core, {
        owner: PROGRAMS.system,
        data: new Uint8Array(33),
      }),
    (chain, rival) =>
      chain.set(rival.core, {
        owner: PROGRAMS.mplCore,
        data: Uint8Array.of(2, ...new Uint8Array(32)),
      }),
  ];
  for (const breakRival of breakages) {
    const chain: SyntheticChain = new Map();
    const rival = await honestAndRival(chain, k);
    breakRival(chain, rival);
    await withRpc(chain, async ({ rpc }) => {
      assert.equal(await resolveOwner(rpc, await nodeIdOf(k)), k.honestOwner);
    });
  }
});

void test('an RPC failure while reading one claimant propagates instead of reading as no owner', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await honestAndRival(chain, k);
  await withRpc(chain, async (fake) => {
    fake.state.failingAddresses.add(k.rivalAsset);
    await assert.rejects(resolveOwner(fake.rpc, await nodeIdOf(k)), (error) =>
      isSolanaError(error),
    );
  });
});

void test('an agent outside the configured collection is rejected unless ANY is allowed', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await addClaimant(chain, {
    owner: k.honestOwner,
    asset: k.honestAsset,
    node: k.node,
  });
  await addClaimant(chain, {
    owner: k.rivalOwner,
    asset: k.rivalAsset,
    node: k.node,
    collection: OTHER_COLLECTION,
  });
  await withRpc(chain, async ({ rpc }) => {
    const nodeId = await nodeIdOf(k);
    assert.equal(await resolveOwner(rpc, nodeId), k.honestOwner);
    await assert.rejects(
      readNodeIdentity(rpc, { asset: k.rivalAsset }),
      hasCode(IDENTITY_ERROR_CODES.COLLECTION_MISMATCH),
    );
    const any = { collection: COLLECTION_POLICY.ANY };
    assert.equal(
      (await readNodeIdentity(rpc, { asset: k.rivalAsset }, any))?.owner,
      k.rivalOwner,
    );
    await assert.rejects(
      resolveOwner(rpc, nodeId, any),
      hasCode(IDENTITY_ERROR_CODES.NODE_ID_AMBIGUOUS),
    );
  });
});

void test('reading by owner skips a broken asset and keeps the healthy one', async () => {
  const k = await keys();
  const chain: SyntheticChain = new Map();
  await addClaimant(chain, {
    owner: k.honestOwner,
    asset: k.honestAsset,
    node: k.node,
  });
  const broken = await addClaimant(chain, {
    owner: k.honestOwner,
    asset: k.rivalAsset,
    node: k.node,
  });
  chain.set(broken.core, {
    owner: PROGRAMS.mplCore,
    data: burnedCoreAssetBytes(),
  });
  await withRpc(chain, async ({ rpc }) => {
    const owned = await readNodeIdentity(rpc, { owner: k.honestOwner });
    assert.deepEqual(
      owned.map((identity) => identity.asset),
      [k.honestAsset],
    );
  });
});

void test('metadata whose asset or key does not match its PDA is an invalid binding', async () => {
  const k = await keys();
  const binding = encodeBindingValue(
    await signNodeBinding(k.node, k.honestAsset, k.honestOwner),
  );
  const forgeries = [
    metadataBytes(k.rivalAsset, METADATA_KEYS.nodeId, binding),
    metadataBytes(k.honestAsset, 'gyblos.other', binding),
  ];
  for (const forged of forgeries) {
    const chain: SyntheticChain = new Map();
    const honest = await addClaimant(chain, {
      owner: k.honestOwner,
      asset: k.honestAsset,
      node: k.node,
    });
    chain.set(honest.metadata, { owner: PROGRAMS.registry, data: forged });
    await withRpc(chain, async ({ rpc }) => {
      const identity = await readNodeIdentity(rpc, { asset: k.honestAsset });
      assert.equal(identity?.bindingStatus, BINDING_STATUSES.INVALID);
    });
  }
});

void test('agent, Core asset and metadata accounts owned by another program are rejected', async () => {
  const k = await keys();
  const foreignPieces = ['agent', 'core', 'metadata'] as const;
  for (const piece of foreignPieces) {
    const chain: SyntheticChain = new Map();
    const honest = await addClaimant(chain, {
      owner: k.honestOwner,
      asset: k.honestAsset,
      node: k.node,
    });
    const original = chain.get(honest[piece]);
    assert.ok(original);
    chain.set(honest[piece], { owner: PROGRAMS.system, data: original.data });
    await withRpc(chain, async ({ rpc }) => {
      await assert.rejects(
        readNodeIdentity(rpc, { asset: k.honestAsset }),
        hasCode(IDENTITY_ERROR_CODES.ACCOUNT_OWNER_MISMATCH),
      );
    });
  }
});
