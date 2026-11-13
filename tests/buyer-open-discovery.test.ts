// Open discovery: a buyer may use sellers it never configured, found in the index, but only when it asked
// for it, only with registry identity configured, only for sellers whose NodeId is registered to the
// catalog's owner, dialed through the configured relay (never an index address), and within the
// candidate bound. Signed synthetic records and a fake index only; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { primaryRelayUrl } from '@gyblos/transport-iroh/endpoint';

import {
  discoveryHome,
  discoveryResponse,
  discoveryRun,
} from './support/buyer-discovery';

const IDENTITY = { rpcUrl: 'https://rpc.test' };

void test('open discovery needs registry identity, and may start with no configured seller', async () => {
  const run = await discoveryRun();
  try {
    const raw = (extra: Record<string, unknown>) => ({
      ...run.config,
      discovery: { ...run.config.discovery, open: true },
      ...extra,
    });
    assert.throws(() => parseBuyerSelectionConfig(raw({})));
    assert.throws(() =>
      parseBuyerSelectionConfig(
        raw({ discovery: { ...run.config.discovery, open: 'yes' } }),
      ),
    );
    const parsed = parseBuyerSelectionConfig(
      raw({ identity: IDENTITY, sellers: [] }),
    );
    assert.equal(parsed.discovery?.open, true);
    assert.deepEqual(parsed.sellers, []);
    // Without open discovery an empty list is still refused.
    assert.throws(() =>
      parseBuyerSelectionConfig({ ...run.config, sellers: [] }),
    );
  } finally {
    await run.wire.close();
  }
});

void test('a seller found only in the index is used when its identity is registered, through the relay', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const open = {
      ...run.config,
      sellers: [],
      identity: IDENTITY,
      discovery: { ...run.config.discovery, open: true as const },
    };
    const checked: string[] = [];
    const found = await discoverBuyerSellers(open, home.state, {
      fetch: async () => discoveryResponse([run.entry]),
      now: run.context.now,
      openRelay: primaryRelayUrl(),
      verifyIdentity: async (seller) => {
        checked.push(seller.nodeId);
        return true;
      },
    });
    assert.deepEqual(checked, [run.entry.catalog.record.nodeId]);
    assert.deepEqual(found.sellers, [
      {
        owner: run.entry.catalog.record.owner,
        nodeId: run.entry.catalog.record.nodeId,
        relayUrl: primaryRelayUrl(),
        directAddresses: [],
      },
    ]);
    // An identity the registry does not confirm is never used.
    const refused = await discoverBuyerSellers(open, home.state, {
      fetch: async () => discoveryResponse([run.entry]),
      now: run.context.now,
      openRelay: primaryRelayUrl(),
      verifyIdentity: async () => false,
    });
    assert.deepEqual(refused.sellers, []);
    // Without open discovery, an unconfigured seller is only a hint, as before.
    const closed = await discoverBuyerSellers(
      { ...open, discovery: run.config.discovery },
      home.state,
      {
        fetch: async () => discoveryResponse([run.entry]),
        now: run.context.now,
        openRelay: primaryRelayUrl(),
        verifyIdentity: async () => true,
      },
    );
    assert.deepEqual(closed.sellers, []);
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('open discovery adds nobody once the configured sellers fill the candidate bound', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const filler = Array.from(
      { length: BUYER_SELECTION.maxSellers },
      (_, index) => ({
        ...run.config.sellers[0]!,
        nodeId: index.toString(16).padStart(64, '0'),
      }),
    );
    let checked = 0;
    const found = await discoverBuyerSellers(
      {
        ...run.config,
        sellers: filler,
        identity: IDENTITY,
        discovery: { ...run.config.discovery, open: true },
      },
      home.state,
      {
        fetch: async () => discoveryResponse([run.entry]),
        now: run.context.now,
        openRelay: primaryRelayUrl(),
        verifyIdentity: async (seller) => {
          if (seller.nodeId === run.entry.catalog.record.nodeId) checked++;
          return true;
        },
      },
    );
    assert.equal(checked, 0);
    assert.ok(
      !found.sellers.some(
        (seller) => seller.nodeId === run.entry.catalog.record.nodeId,
      ),
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('a seller this request excluded is not brought back, and a refused identity is not looked up again soon', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const open = {
      ...run.config,
      sellers: [],
      identity: IDENTITY,
      discovery: { ...run.config.discovery, open: true as const },
    };
    const nodeId = run.entry.catalog.record.nodeId;
    let lookups = 0;
    const discover = (excluded: ReadonlySet<string>, ok: boolean) =>
      discoverBuyerSellers(open, home.state, {
        fetch: async () => discoveryResponse([run.entry]),
        now: run.context.now,
        openRelay: primaryRelayUrl(),
        excluded,
        verifyIdentity: async () => {
          lookups++;
          return ok;
        },
      });
    // Failover: the request already tried this seller, so the index does not offer it again.
    assert.deepEqual((await discover(new Set([nodeId]), true)).sellers, []);
    assert.equal(lookups, 0);
    // An unregistered NodeId costs one lookup, then is skipped for a while.
    assert.deepEqual((await discover(new Set(), false)).sellers, []);
    assert.deepEqual((await discover(new Set(), false)).sellers, []);
    assert.equal(lookups, 1);
  } finally {
    await run.wire.close();
    await home.close();
  }
});
