// Runs configured buyer discovery/selection against a synthetic loopback registry and control seller.
// State lives in canonical temporary homes; no real registry, private content or payments.
import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { address, getAddressDecoder } from '@solana/kit';

import {
  BUYER_SELECTION,
  BUYER_SELECTION_CODES,
} from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import {
  prepareBuyerIdentity,
  verifyBuyerIdentity,
} from '@gyblos/buyer/identity';
import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import { prepareBuyerSelection } from '@gyblos/buyer/selection-runtime';
import { homeLayout, ROLE_FILES } from '@gyblos/config/home';
import {
  IDENTITY_LOOKUP_KINDS,
  IDENTITY_POLICY_CODES,
  IDENTITY_TRUST_SOURCES,
} from '@gyblos/core/identity-policy';
import { openBuyerIdentityVerifier } from '@gyblos/node/identity-verifier';

import {
  discoveryHome,
  discoveryResponse,
  discoveryRun,
} from './support/buyer-discovery.js';
import {
  addClaimant,
  type SyntheticChain,
} from './support/identity-accounts.js';
import { fixedSigner } from './support/identity-fixture.js';
import { startFakeRpc } from './support/identity-rpc-fake.js';

async function fixture() {
  const home = await discoveryHome();
  const run = await discoveryRun();
  const environment = { GYBLOS_HOME: await realpath(home.directory) };
  const chain: SyntheticChain = new Map();
  const node = {
    address: getAddressDecoder().decode(Buffer.from(run.catalog.nodeId, 'hex')),
    signDetached: (bytes: Uint8Array) => run.nodeSigner(Uint8Array.from(bytes)),
  };
  const asset = (await fixedSigner(42)).address;
  const accounts = await addClaimant(chain, {
    owner: address(run.catalog.owner),
    asset,
    node,
    sequence: 9007199254740993n,
  });
  const rpc = await startFakeRpc(chain);
  const config = { ...run.config, identity: { rpcUrl: rpc.url } };
  await writeFile(
    join(homeLayout(environment).roles.buyer, BUYER_SELECTION.configFile),
    JSON.stringify(config),
    { mode: 0o600 },
  );
  return {
    home,
    run,
    environment,
    chain,
    node,
    asset,
    accounts,
    rpc,
    config,
    async close() {
      await rpc.close();
      await run.wire.close();
      await home.close();
    },
  };
}
void test('configured registry buyer discovers and quotes only after independent identity proof, retaining exact sequence across restart', async () => {
  const source = await fixture();
  try {
    const prepared = await prepareBuyerSelection(source.environment);
    assert.ok(prepared?.identity && prepared.discovery);
    const check = (
      seller: (typeof source.config.sellers)[number],
      signal?: AbortSignal,
    ) => verifyBuyerIdentity(prepared.identity, seller, signal);
    const config = await discoverBuyerSellers(
      source.config,
      prepared.discovery,
      {
        fetch: async () => discoveryResponse([source.run.entry]),
        now: source.run.context.now,
        verifyIdentity: check,
      },
    );
    assert.equal(config.sellers.length, 1);
    const selected = await selectVerifiedBuyerQuote(config, {
      ...source.run.dependencies,
      verifyIdentity: check,
      observeVerified: (seller) =>
        prepared.discovery!.observe(seller, { allowOwnerChange: true }),
    });
    assert.equal(selected.ok, true);
    assert.ok(source.rpc.state.calls.length > 0);
    assert.ok(
      source.rpc.state.calls.every((method) =>
        [
          'getGenesisHash',
          'getProgramAccounts',
          'getMultipleAccounts',
        ].includes(method),
      ),
    );
    source.chain.delete(source.accounts.core);
    const restarted = await prepareBuyerSelection(source.environment);
    assert.ok(restarted?.identity);
    const denied = await restarted.identity.verify(source.config.sellers[0]!);
    assert.equal(denied.ok, false);
    assert.equal(denied.state?.binding.sequence, 9007199254740993n);
    assert.equal(denied.state?.revoked, true);
    const oldCalls = source.rpc.state.calls.length;
    const manual = await restarted.identity.verify({
      ...source.config.sellers[0]!,
      manualTrust: true,
    });
    assert.ok(manual.ok);
    assert.equal(manual.source, IDENTITY_TRUST_SOURCES.MANUAL);
    assert.equal(source.rpc.state.calls.length, oldCalls);
    assert.equal(manual.state?.revoked, true);
    await addClaimant(source.chain, {
      owner: address(source.run.catalog.owner),
      asset: source.asset,
      node: source.node,
      sequence: 9007199254740993n,
    });
    const afterManual = await openBuyerIdentityVerifier(
      source.environment,
      source.rpc.rpc,
    );
    const stale = await afterManual.verify(source.config.sellers[0]!);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, IDENTITY_POLICY_CODES.REVOKED);
  } finally {
    await source.close();
  }
});
void test('registry outage excludes discovery without erasing state, but an explicit manual override bypasses only the lookup', async () => {
  const source = await fixture();
  try {
    const verifier = await openBuyerIdentityVerifier(
      source.environment,
      source.rpc.rpc,
    );
    const seller = source.config.sellers[0]!;
    assert.equal((await verifier.verify(seller)).ok, true);
    source.rpc.state.failingMethods.add('getGenesisHash');
    const outage = await verifier.verify(seller);
    assert.equal(outage.ok, false);
    assert.equal(outage.state?.revoked, false);
    const manual = await verifier.verify({ ...seller, manualTrust: true });
    assert.ok(manual.ok);
    assert.equal(manual.source, IDENTITY_TRUST_SOURCES.MANUAL);
    const path = join(
      homeLayout(source.environment).roles.buyer,
      ROLE_FILES.identityState,
    );
    await writeFile(path, '{}', { mode: 0o600 });
    await assert.rejects(
      verifyBuyerIdentity(verifier, { ...seller, manualTrust: true }),
      { code: BUYER_SELECTION_CODES.IDENTITY_STATE },
    );
  } finally {
    await source.close();
  }
});
void test('aborted identity checks do not produce admitted trust or registry calls', async () => {
  const source = await fixture();
  try {
    const verifier = await openBuyerIdentityVerifier(
      source.environment,
      source.rpc.rpc,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      verifier.verify(source.config.sellers[0]!, controller.signal),
      { name: 'AbortError' },
    );
    assert.equal(source.rpc.state.calls.length, 0);
  } finally {
    await source.close();
  }
});

void test('configured identity trust rejects a request network outside the pinned registry profile before RPC', async () => {
  const source = await fixture();
  try {
    await assert.rejects(
      prepareBuyerIdentity(source.environment, {
        ...source.config,
        request: { ...source.config.request, network: 'solana:mainnet' },
      }),
      { code: BUYER_SELECTION_CODES.IDENTITY },
    );
    assert.equal(source.rpc.state.calls.length, 0);
  } finally {
    await source.close();
  }
});
