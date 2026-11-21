// Open discovery reads every page of the index, drops sellers that could not serve the request, and
// spends its bounded identity lookups on a random draw of the rest: which unconfigured sellers are
// looked up never depends on the index's order. Signed synthetic records and a fake index only.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { BUYER_DISCOVERY, BUYER_SELECTION } from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { PUBLIC_V2_DOMAINS } from '@gyblos/protocol/constants';
import type {
  PublicCatalogV2,
  PublicRecordV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';
import { signingBytes } from '@gyblos/protocol/signing';
import { primaryRelayUrl } from '@gyblos/transport-iroh/endpoint';

import {
  discoveryHome,
  discoveryResponse,
  discoveryRun,
} from './support/buyer-discovery';

type Run = Awaited<ReturnType<typeof discoveryRun>>;

// Another seller like the fixture's, under its own key, optionally at other prices.
async function otherSeller(run: Run, outputAtomicPerMtok?: string) {
  const keys = generateKeyPairSync('ed25519');
  const nodeId = Buffer.from(
    keys.publicKey.export({ format: 'jwk' }).x!,
    'base64url',
  ).toString('hex');
  const signed = (record: PublicRecordV2): SignedPublicV2 => ({
    record,
    signature: sign(
      null,
      signingBytes(PUBLIC_V2_DOMAINS[record.kind], record),
      keys.privateKey,
    ).toString('hex'),
  });
  const base = run.entry.catalog.record as PublicCatalogV2;
  const catalog: PublicCatalogV2 = {
    ...base,
    nodeId,
    models: base.models.map((model) => ({
      ...model,
      pricing: {
        ...model.pricing,
        ...(outputAtomicPerMtok ? { outputAtomicPerMtok } : {}),
      },
    })),
  };
  const presence = {
    ...run.entry.presence.record,
    nodeId,
    catalogDigest: await catalogDigestV2(catalog),
  } as PublicRecordV2;
  return {
    nodeId,
    entry: { catalog: signed(catalog), presence: signed(presence) },
  };
}

function openConfig(run: Run) {
  return {
    ...run.config,
    sellers: [],
    identity: { rpcUrl: 'https://rpc.test' },
    discovery: { ...run.config.discovery, open: true as const },
  };
}

// `pages` as the index's pages; every request and lookup is written to `log` in order.
function pagedIndex(pages: unknown[][], log: string[]) {
  return async (input: string | URL | Request) => {
    const query = new URL(String(input)).searchParams;
    log.push(`page limit=${query.get('limit')}`);
    const index = Number(query.get('cursor') ?? 0);
    const next = index + 1 < pages.length ? String(index + 1) : null;
    return discoveryResponse(pages[index]!, next);
  };
}

async function discoverOpen(
  run: Run,
  state: Awaited<ReturnType<typeof discoveryHome>>['state'],
  pages: unknown[][],
  options: {
    random?: () => number;
    accept?: boolean;
    previousSeller?: string;
  } = {},
) {
  const log: string[] = [];
  const checked: string[] = [];
  const config = {
    ...openConfig(run),
    ...(options.previousSeller
      ? { previousSeller: options.previousSeller }
      : {}),
  };
  const found = await discoverBuyerSellers(config, state, {
    fetch: pagedIndex(pages, log),
    now: run.context.now,
    openRelay: primaryRelayUrl(),
    ...(options.random ? { random: options.random } : {}),
    verifyIdentity: async (seller) => {
      log.push('lookup');
      checked.push(seller.nodeId);
      return options.accept ?? true;
    },
  });
  return { log, checked, found };
}

void test('every page is read at the index page size before any lookup, and lookups follow the draw', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const sellers = await Promise.all(
      Array.from({ length: 20 }, () => otherSeller(run)),
    );
    const listed = sellers.map((seller) => seller.nodeId);
    const pages = [sellers.slice(0, 10), sellers.slice(10)].map((page) =>
      page.map((seller) => seller.entry),
    );
    // A draw that keeps every seller in place looks up the index's first ones.
    const kept = await discoverOpen(run, home.state, pages, {
      random: () => 0.999_999,
    });
    assert.deepEqual(kept.log.slice(0, 2), [
      'page limit=200',
      'page limit=200',
    ]);
    assert.ok(kept.log.slice(2).every((event) => event === 'lookup'));
    assert.deepEqual(kept.checked, listed.slice(0, BUYER_SELECTION.maxSellers));
    // A draw that moves every seller looks up ones the index order would never reach.
    const moved = await discoverOpen(run, home.state, pages, {
      random: () => 0,
    });
    assert.deepEqual(
      moved.checked,
      listed.slice(1, BUYER_SELECTION.maxSellers + 1),
    );
    // The conversation's previous seller is looked up first, wherever the index lists it.
    const previous = listed.at(-1)!;
    const resumed = await discoverOpen(run, home.state, pages, {
      random: () => 0.999_999,
      previousSeller: previous,
    });
    assert.equal(resumed.checked[0], previous);
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('refused identities stop at the lookup bound, and a seller listed twice is drawn once', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const sellers = await Promise.all(
      Array.from({ length: 20 }, () => otherSeller(run)),
    );
    const refused = await discoverOpen(
      run,
      home.state,
      [sellers.map((seller) => seller.entry)],
      { accept: false },
    );
    assert.equal(refused.checked.length, BUYER_DISCOVERY.openLookups);
    assert.deepEqual(refused.found.sellers, []);
    // One draw per seller: a NodeId on two pages takes one place, so three sellers take two draws.
    const [a, b, c] = await Promise.all([
      otherSeller(run),
      otherSeller(run),
      otherSeller(run),
    ]);
    let draws = 0;
    const twice = await discoverOpen(
      run,
      home.state,
      [
        [a!.entry, b!.entry],
        [a!.entry, c!.entry],
      ],
      {
        random: () => {
          draws++;
          return 0.5;
        },
      },
    );
    assert.equal(draws, 2);
    assert.equal(twice.checked.length, 3);
    assert.equal(new Set(twice.checked).size, 3);
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('a seller that could not serve the request is never looked up', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const ceiling = BigInt(
      run.config.request.priceCeilings.outputAtomicPerMtok,
    );
    const cheap = await otherSeller(run);
    const dear = await otherSeller(run, String(ceiling + 1n));
    const { checked, found } = await discoverOpen(run, home.state, [
      [dear.entry, cheap.entry],
    ]);
    assert.deepEqual(checked, [cheap.nodeId]);
    assert.deepEqual(
      found.sellers.map((seller) => seller.nodeId),
      [cheap.nodeId],
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('a drawn seller whose pages list a same-sequence fork is blocked, never silently chosen', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const altered = {
      ...run.catalog,
      models: run.catalog.models.map((model) => ({
        ...model,
        contextTokens: model.contextTokens + 1,
      })),
    };
    const fork = {
      catalog: await signPublicV2(altered, run.nodeSigner),
      presence: await signPublicV2(
        {
          ...run.known.presence!,
          catalogDigest: await catalogDigestV2(altered),
        },
        run.nodeSigner,
      ),
    };
    const { found } = await discoverOpen(run, home.state, [
      [run.entry],
      [fork],
    ]);
    assert.deepEqual(found.sellers, []);
    const owner = run.entry.catalog.record.owner;
    const nodeId = run.entry.catalog.record.nodeId;
    assert.deepEqual(
      (await buyerDiscoveryState(home.environment)).eligible(
        [{ owner, nodeId }],
        run.context.now(),
      ),
      [],
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});
