// Open discovery reads every page of the index, drops sellers that could not serve the request, and
// spends its bounded identity lookups on a random draw of the rest: which unconfigured sellers are
// looked up never depends on the index's order. Signed synthetic records and a fake index only.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { BUYER_DISCOVERY, BUYER_SELECTION } from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { PUBLIC_V2_DOMAINS } from '@gyblos/protocol/constants';
import type {
  PublicCatalogV2,
  PublicRecordV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';
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

// Two pages of `sellers`, split in half; records each requested page's query.
function twoPages(entries: unknown[], queries: URLSearchParams[]) {
  const half = Math.ceil(entries.length / 2);
  return async (input: string | URL | Request) => {
    const query = new URL(String(input)).searchParams;
    queries.push(query);
    return query.get('cursor')
      ? discoveryResponse(entries.slice(half))
      : discoveryResponse(entries.slice(0, half), 'page-2');
  };
}

void test('identity lookups follow a random draw over every page, never the index order', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const sellers = await Promise.all(
      Array.from({ length: 20 }, () => otherSeller(run)),
    );
    const listed = sellers.map((seller) => seller.nodeId);
    const discover = async (random: () => number) => {
      const checked: string[] = [];
      const queries: URLSearchParams[] = [];
      await discoverBuyerSellers(openConfig(run), home.state, {
        fetch: twoPages(
          sellers.map((seller) => seller.entry),
          queries,
        ),
        now: run.context.now,
        openRelay: primaryRelayUrl(),
        random,
        verifyIdentity: async (seller) => {
          checked.push(seller.nodeId);
          return true;
        },
      });
      return { checked, queries };
    };
    // A draw that keeps every seller in place looks up the index's first ones.
    const kept = await discover(() => 0.999_999);
    assert.equal(kept.checked.length, BUYER_SELECTION.maxSellers);
    assert.deepEqual(kept.checked, listed.slice(0, BUYER_SELECTION.maxSellers));
    // Both pages were read, at the index's largest page, before any lookup.
    assert.equal(kept.queries.length, 2);
    assert.equal(
      kept.queries[0]!.get('limit'),
      String(BUYER_DISCOVERY.pageSize),
    );
    // Another draw reaches sellers the index order would never look up.
    const moved = await discover(() => 0);
    const late = new Set(listed.slice(BUYER_SELECTION.maxSellers));
    assert.ok(moved.checked.some((nodeId) => late.has(nodeId)));
    assert.equal(new Set(moved.checked).size, moved.checked.length);
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
    const checked: string[] = [];
    const found = await discoverBuyerSellers(openConfig(run), home.state, {
      fetch: async () => discoveryResponse([dear.entry, cheap.entry]),
      now: run.context.now,
      openRelay: primaryRelayUrl(),
      verifyIdentity: async (seller) => {
        checked.push(seller.nodeId);
        return true;
      },
    });
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
