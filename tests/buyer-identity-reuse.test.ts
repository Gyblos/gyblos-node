// Exercises public identity reuse with deterministic clocks, synthetic signed accounts and loopback RPC.
// No real chain, funded keys, discovery trust or operator data is used.
import assert from 'node:assert/strict';
import { readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { getAddressEncoder } from '@solana/kit';

import { homeLayout, ROLE_FILES } from '@gyblos/config/home';
import { BUYER_IDENTITY, IDENTITY_STATE } from '@gyblos/node/constants';
import { openBuyerIdentityVerifier } from '@gyblos/node/identity-verifier';
import { canonicalJson } from '@gyblos/protocol';

import { discoveryHome } from './support/buyer-discovery';
import { addClaimant, type SyntheticChain } from './support/identity-accounts';
import { fixedSigner } from './support/identity-fixture';
import { startFakeRpc } from './support/identity-rpc-fake';

async function fixture() {
  const home = await discoveryHome();
  const node = await fixedSigner(51);
  const owner = (await fixedSigner(52)).address;
  const asset = (await fixedSigner(53)).address;
  const nodeId = Buffer.from(getAddressEncoder().encode(node.address)).toString(
    'hex',
  );
  const chain: SyntheticChain = new Map();
  const accounts = await addClaimant(chain, {
    node,
    owner,
    asset,
    sequence: 1n,
  });
  const rpc = await startFakeRpc(chain);
  return {
    home,
    environment: { GYBLOS_HOME: await realpath(home.directory) },
    chain,
    accounts,
    rpc,
    subject: { nodeId, owner },
    async close() {
      await rpc.close();
      await home.close();
    },
  };
}
void test('public identity verifier rejects non-finite, fractional and out-of-range reuse before RPC', async () => {
  const f = await fixture();
  try {
    for (const freshLookupMs of [
      NaN,
      Infinity,
      -Infinity,
      -1,
      0.5,
      BUYER_IDENTITY.maxFreshLookupMs + 1,
    ]) {
      await assert.rejects(
        openBuyerIdentityVerifier(f.environment, f.rpc.rpc, undefined, {
          freshLookupMs,
        }),
        RangeError,
      );
    }
    assert.equal(f.rpc.state.calls.length, 0);
  } finally {
    await f.close();
  }
});
void test('public identity verifier accepts zero and the canonical maximum reuse duration', async () => {
  const f = await fixture();
  try {
    for (const freshLookupMs of [0, BUYER_IDENTITY.maxFreshLookupMs])
      assert.equal(
        typeof (
          await openBuyerIdentityVerifier(f.environment, f.rpc.rpc, undefined, {
            freshLookupMs,
          })
        ).verify,
        'function',
      );
    assert.equal(f.rpc.state.calls.length, 0);
  } finally {
    await f.close();
  }
});
void test('wall-clock rollback cannot extend identity reuse beyond monotonic elapsed time', async () => {
  const f = await fixture();
  let wall = 1_000_000;
  let elapsed = 0;
  try {
    const verifier = await openBuyerIdentityVerifier(
      f.environment,
      f.rpc.rpc,
      undefined,
      { now: () => wall, monotonicNow: () => elapsed },
    );
    assert.equal((await verifier.verify(f.subject)).ok, true);
    f.chain.delete(f.accounts.core);
    wall += 240_000;
    elapsed += 240_000;
    assert.equal((await verifier.verify(f.subject)).ok, true);
    const calls = f.rpc.state.calls.length;
    wall -= 120_000;
    elapsed += 120_000;
    const decision = await verifier.verify(f.subject);
    assert.equal(decision.ok, false);
    assert.equal(decision.state?.revoked, true);
    assert.ok(f.rpc.state.calls.length > calls);
  } finally {
    await f.close();
  }
});
void test('suspension expires reuse by wall time even when the monotonic clock did not advance', async () => {
  const f = await fixture();
  let wall = 1_000_000;
  try {
    const verifier = await openBuyerIdentityVerifier(
      f.environment,
      f.rpc.rpc,
      undefined,
      { now: () => wall, monotonicNow: () => 0 },
    );
    assert.equal((await verifier.verify(f.subject)).ok, true);
    f.chain.delete(f.accounts.core);
    wall += BUYER_IDENTITY.freshLookupMs;
    assert.equal((await verifier.verify(f.subject)).ok, false);
  } finally {
    await f.close();
  }
});
void test('reuse expiring while durable policy is evaluated triggers a fresh registry read before admission', async () => {
  const f = await fixture();
  let crossing = false;
  let reads = 0;
  try {
    const verifier = await openBuyerIdentityVerifier(
      f.environment,
      f.rpc.rpc,
      undefined,
      {
        freshLookupMs: 10,
        now: () => (crossing ? (++reads === 1 ? 9 : 11) : 0),
        monotonicNow: () => 0,
      },
    );
    assert.equal((await verifier.verify(f.subject)).ok, true);
    f.chain.delete(f.accounts.core);
    crossing = true;
    assert.equal((await verifier.verify(f.subject)).ok, false);
  } finally {
    await f.close();
  }
});
void test('another verifier observing revocation immediately blocks a still-fresh cached binding', async () => {
  const f = await fixture();
  try {
    const cached = await openBuyerIdentityVerifier(f.environment, f.rpc.rpc);
    assert.equal((await cached.verify(f.subject)).ok, true);
    f.chain.delete(f.accounts.core);
    const fresh = await openBuyerIdentityVerifier(
      f.environment,
      f.rpc.rpc,
      undefined,
      { freshLookupMs: 0 },
    );
    assert.equal((await fresh.verify(f.subject)).ok, false);
    const reads = f.rpc.state.calls.length;
    assert.equal((await cached.verify(f.subject)).ok, false);
    assert.equal(f.rpc.state.calls.length, reads);
  } finally {
    await f.close();
  }
});
void test('a reused binding whose row another process pruned is read from the registry again', async () => {
  const f = await fixture();
  try {
    const verifier = await openBuyerIdentityVerifier(f.environment, f.rpc.rpc, {
      configuredNodeIds: [],
    });
    assert.equal((await verifier.verify(f.subject)).ok, true);
    const file = join(
      homeLayout(f.environment).roles.buyer,
      ROLE_FILES.identityState,
    );
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const [row] = saved.rows;
    saved.rows = Array.from({ length: IDENTITY_STATE.maxRows }, (_, n) => ({
      ...row,
      binding: {
        ...row.binding,
        nodeId: (n + 1).toString(16).padStart(64, '0'),
      },
    }));
    await writeFile(file, canonicalJson(saved), { mode: 0o600 });
    const calls = f.rpc.state.calls.length;
    assert.equal((await verifier.verify(f.subject)).ok, true);
    assert.ok(f.rpc.state.calls.length > calls);
  } finally {
    await f.close();
  }
});

void test('a cache check that cannot read the history falls back to the registry', async () => {
  const f = await fixture();
  try {
    const verifier = await openBuyerIdentityVerifier(f.environment, f.rpc.rpc, {
      configuredNodeIds: [],
    });
    assert.equal((await verifier.verify(f.subject)).ok, true);
    const file = join(
      homeLayout(f.environment).roles.buyer,
      ROLE_FILES.identityState,
    );
    const saved = await readFile(file, 'utf8');
    await rm(file);
    await symlink(join(file, '..', 'missing'), file);
    const calls = f.rpc.state.calls.length;
    await assert.rejects(verifier.verify(f.subject));
    assert.ok(f.rpc.state.calls.length > calls);
    await rm(file);
    await writeFile(file, saved, { mode: 0o600 });
  } finally {
    await f.close();
  }
});
