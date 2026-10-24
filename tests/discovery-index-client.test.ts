// Protects the end-to-end contract between @gyblos/discovery-http and the discovery index app over an
// in-process fetch at the configured DISCOVERY_INDEX_URL. Records are signed with protocol helpers.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { DISCOVERY_INDEX_URL } from '@gyblos/config';
import {
  DISCOVERY_ERROR_CODES,
  fetchSellers,
  publishRecord,
} from '@gyblos/discovery-http';
import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { DISCOVERY_LIMITERS } from '@gyblos/discovery-index/constants';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';
import {
  PUBLIC_PRESENCE_STATE,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';
import type {
  PublicCatalogV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';

import { rejectsWith } from './support/discovery-fixture.js';
import {
  allLimiters,
  deny,
  eachStorage,
  indexNode,
  MODEL,
  T0,
  type IndexHarness,
} from './support/discovery-index-fixture.js';

// The client calls `${DISCOVERY_INDEX_URL}/records` and `/sellers`; route them into the app.
function clientFetch(app: {
  fetch: (request: Request) => Response | Promise<Response>;
}) {
  return async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(`${DISCOVERY_INDEX_URL}/`), url);
    return app.fetch(new Request(url, init));
  };
}

// A node that signs through signPublicV2 with an injected Ed25519 signer.
async function protocolNode() {
  const keys = generateKeyPairSync('ed25519');
  const signer = async (bytes: Uint8Array<ArrayBuffer>) =>
    Uint8Array.from(sign(null, bytes, keys.privateKey));
  const template = indexNode().catalog(1).record;
  const nodeId = Buffer.from(
    keys.publicKey.export({ format: 'jwk' }).x!,
    'base64url',
  ).toString('hex');
  const catalogAt = async (sequence: number) => {
    const record = { ...template, nodeId, sequence } as PublicCatalogV2;
    return signPublicV2(record, signer);
  };
  const presenceFor = async (catalog: SignedPublicV2, sequence: number) =>
    signPublicV2(
      {
        schemaVersion: catalog.record.schemaVersion,
        kind: PUBLIC_RECORD_KINDS.PRESENCE,
        owner: catalog.record.owner,
        nodeId,
        sequence,
        issuedAt: T0,
        expiresAt: T0 + 90_000,
        catalogDigest: await catalogDigestV2(catalog.record),
        state: PUBLIC_PRESENCE_STATE,
      },
      signer,
    );
  return { nodeId, catalogAt, presenceFor };
}

const now = () => T0 + 1000;

eachStorage(
  'publishRecord and fetchSellers round-trip through the index',
  async (harness: IndexHarness) => {
    const fetch = clientFetch(harness.app);
    const node = await protocolNode();
    const catalog = await node.catalogAt(1);
    const presence = await node.presenceFor(catalog, 2);
    assert.deepEqual(
      await publishRecord({
        baseUrl: DISCOVERY_INDEX_URL,
        record: catalog,
        fetch,
      }),
      { ok: true },
    );
    assert.deepEqual(
      await publishRecord({
        baseUrl: DISCOVERY_INDEX_URL,
        record: presence,
        fetch,
      }),
      { ok: true },
    );
    const result = await fetchSellers({
      baseUrl: DISCOVERY_INDEX_URL,
      model: MODEL,
      fetch,
      now,
    });
    assert.equal(result.dropped, 0);
    assert.equal(result.next, null);
    assert.equal(result.generatedAt, T0 + 1000);
    assert.deepEqual(result.sellers, [
      { catalog: catalog.record, presence: presence.record, withdrawal: null },
    ]);
    const replay = await fetchSellers({
      baseUrl: DISCOVERY_INDEX_URL,
      model: MODEL,
      fetch,
      now,
      lastSequence: () => 2,
    });
    assert.deepEqual([replay.sellers.length, replay.dropped], [0, 1]);
  },
);

eachStorage(
  'index rejections surface as the client static codes',
  async (harness: IndexHarness) => {
    const fetch = clientFetch(harness.app);
    const node = await protocolNode();
    const catalog = await node.catalogAt(3);
    await publishRecord({
      baseUrl: DISCOVERY_INDEX_URL,
      record: catalog,
      fetch,
    });
    await assert.rejects(
      publishRecord({
        baseUrl: DISCOVERY_INDEX_URL,
        record: await node.catalogAt(2),
        fetch,
      }),
      rejectsWith(DISCOVERY_ERROR_CODES.STALE_RECORD, 409),
    );
    const flipped = {
      ...catalog,
      signature:
        (catalog.signature[0] === '0' ? '1' : '0') + catalog.signature.slice(1),
    };
    const unsigned = { ...flipped, record: { ...flipped.record, sequence: 9 } };
    await assert.rejects(
      publishRecord({ baseUrl: DISCOVERY_INDEX_URL, record: unsigned, fetch }),
      rejectsWith(DISCOVERY_ERROR_CODES.INVALID_SIGNATURE, 400),
    );
    const orphan = await node.presenceFor(await node.catalogAt(4), 5);
    await assert.rejects(
      publishRecord({ baseUrl: DISCOVERY_INDEX_URL, record: orphan, fetch }),
      rejectsWith(DISCOVERY_ERROR_CODES.UNKNOWN_CATALOG, 400),
    );
  },
);

eachStorage(
  'the client follows index cursors across pages',
  async (harness: IndexHarness) => {
    const fetch = clientFetch(harness.app);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const node = await protocolNode();
      const catalog = await node.catalogAt(1);
      await publishRecord({
        baseUrl: DISCOVERY_INDEX_URL,
        record: catalog,
        fetch,
      });
      await publishRecord({
        baseUrl: DISCOVERY_INDEX_URL,
        record: await node.presenceFor(catalog, 2),
        fetch,
      });
    }
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await fetchSellers({
        baseUrl: DISCOVERY_INDEX_URL,
        model: MODEL,
        fetch,
        now,
        limit: 2,
        cursor,
      });
      for (const seller of page.sellers) seen.add(seller.catalog.nodeId);
      cursor = page.next ?? undefined;
      pages++;
    } while (cursor && pages < 5);
    assert.equal(pages, 2);
    assert.equal(seen.size, 3);
  },
);

eachStorage(
  'rate limits and a missing database map to client codes',
  async () => {
    const node = await protocolNode();
    const catalog = await node.catalogAt(1);
    const limited = createDiscoveryIndex({
      storage: createMemoryStorage(),
      limiters: { ...allLimiters(), [DISCOVERY_LIMITERS.PUBLISH]: deny },
      now,
    });
    await assert.rejects(
      publishRecord({
        baseUrl: DISCOVERY_INDEX_URL,
        record: catalog,
        fetch: clientFetch(limited),
      }),
      rejectsWith(DISCOVERY_ERROR_CODES.RATE_LIMITED, 429),
    );
    const unbound = createDiscoveryIndex({ limiters: allLimiters(), now });
    await assert.rejects(
      fetchSellers({
        baseUrl: DISCOVERY_INDEX_URL,
        model: MODEL,
        fetch: clientFetch(unbound),
        now,
      }),
      rejectsWith(DISCOVERY_ERROR_CODES.UNAVAILABLE, 503),
    );
  },
);
