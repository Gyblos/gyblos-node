// Owns synthetic signed v2 catalog/presence pairs and a recording fake fetch for discovery client tests.
// Ephemeral unfunded node keys only; no network, no global fetch.
import assert from 'node:assert/strict';

import {
  DiscoveryError,
  type DiscoveryErrorCode,
} from '@gyblos/discovery-http';
import {
  CONTROL_RECORD_VERSION,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_RECORD_KINDS,
  REASONING_LEVELS,
  V2_PRICING,
} from '@gyblos/protocol/constants';
import type {
  PublicCatalogV2,
  PublicPresenceV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';

import { PUBLIC_TEST_NOW, publicFixture } from './public-records';

export const DISCOVERY_NOW = PUBLIC_TEST_NOW + 1_000;
export const DISCOVERY_BASE = 'https://index.test/api/v1/discovery';

export interface SellerOptions {
  modelId?: string;
  presenceLifetimeMs?: number;
}

export async function discoverySeller(options: SellerOptions = {}) {
  const source = publicFixture();
  const catalog: PublicCatalogV2 = {
    ...source.catalog,
    schemaVersion: CONTROL_RECORD_VERSION,
    models: source.catalog.models.map((model) => ({
      ...model,
      modelId: options.modelId ?? model.modelId,
      pricing: {
        network: model.pricing.network,
        asset: model.pricing.asset,
        unit: V2_PRICING.unit,
        inputAtomicPerMtok: model.pricing.inputAtomic,
        outputAtomicPerMtok: model.pricing.outputAtomic,
      },
      reasoning: [REASONING_LEVELS.OFF],
    })),
  };
  const { models: _models, dataPolicy: _policy, ...header } = catalog;
  async function presenceFor(target: PublicCatalogV2, sequence = 2) {
    const presence: PublicPresenceV2 = {
      ...header,
      kind: PUBLIC_RECORD_KINDS.PRESENCE,
      sequence,
      issuedAt: PUBLIC_TEST_NOW + 500,
      expiresAt: PUBLIC_TEST_NOW + 500 + (options.presenceLifetimeMs ?? 60_000),
      catalogDigest: await catalogDigestV2(target),
      state: PUBLIC_PRESENCE_STATE,
    };
    return signPublicV2(presence, source.signer);
  }
  const signedCatalog = await signPublicV2(catalog, source.signer);
  const signedPresence = await presenceFor(catalog);
  // A later catalog from the same node with its own presence (sequence + 1).
  async function entryAt(sequence: number) {
    const next: PublicCatalogV2 = { ...catalog, sequence };
    return {
      catalog: await signPublicV2(next, source.signer),
      presence: await presenceFor(next, sequence + 1),
    };
  }
  // The same node advertising `count` distinct models (padded identifiers).
  async function largeCatalog(count: number) {
    const template = catalog.models[0]!;
    const models = Array.from({ length: count }, (_unused, index) => ({
      ...template,
      modelId: `org/model-${String(index).padStart(3, '0')}-${'x'.repeat(100)}`,
    }));
    return signPublicV2({ ...catalog, models }, source.signer);
  }
  return {
    catalog,
    signedCatalog,
    signedPresence,
    entry: { catalog: signedCatalog, presence: signedPresence },
    signer: source.signer,
    presenceFor,
    entryAt,
    largeCatalog,
  };
}

export function forge(signed: SignedPublicV2): SignedPublicV2 {
  const first = signed.signature[0] === '0' ? '1' : '0';
  return { ...signed, signature: first + signed.signature.slice(1) };
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export function fakeFetch(respond: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

export function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function sellersBody(sellers: unknown[], next: string | null = null) {
  return { sellers, next, generatedAt: DISCOVERY_NOW };
}

// An endless body that counts how many chunks the client pulled.
export function endlessResponse(chunkBytes: number) {
  let pulls = 0;
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(chunk);
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    pulls: () => pulls,
  };
}

export function rejectsWith(code: DiscoveryErrorCode, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof DiscoveryError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}
