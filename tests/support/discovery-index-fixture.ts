// Owns synthetic node signers and storage harnesses for discovery index tests: ephemeral unfunded
// Ed25519 keys, a fake clock, switchable fake rate limiters and in-process requests only.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';

import {
  createDiscoveryIndex,
  type DiscoveryIndexOptions,
  type ResponseCache,
} from '@gyblos/discovery-index/app';
import {
  DISCOVERY_LIMITERS,
  PUBLISH_MODES,
  type DiscoveryLimiterName,
} from '@gyblos/discovery-index/constants';
import {
  createMemoryStorage,
  type DiscoveryStorage,
  type StoredEntry,
} from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import {
  CONTROL_RECORD_VERSION,
  DATA_RETENTION,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_RECORD_KINDS,
  PUBLIC_V2_DOMAINS,
  REASONING_LEVELS,
  V2_PRICING,
} from '@gyblos/protocol/constants';
import type {
  PublicCatalogV2,
  PublicRecordV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';
import { signingBytes } from '@gyblos/protocol/signing';

import { createSqliteD1 } from './d1-sqlite.js';
import { PUBLIC_TEST_NOW } from './public-records.js';

export const T0 = PUBLIC_TEST_NOW;
export const INDEX_OWNER = 'HF7czidh6AtTmrAwa9S9obGXsvg7588CxSqEL3FQR2VS';
export const CLIENT_IP = '203.0.113.77';
export const INDEX_ORIGIN = 'https://discovery.gyblos.com';
export const MODEL = 'qwen3-0.6b';

export interface FakeLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
export const allow: FakeLimiter = { limit: async () => ({ success: true }) };
export const deny: FakeLimiter = { limit: async () => ({ success: false }) };
export const broken: FakeLimiter = {
  limit: async () => {
    throw new Error('limiter down');
  },
};
export const allLimiters = (limiter: FakeLimiter = allow) => ({
  [DISCOVERY_LIMITERS.IP]: limiter,
  [DISCOVERY_LIMITERS.PUBLISH]: limiter,
  [DISCOVERY_LIMITERS.NODE]: limiter,
  [DISCOVERY_LIMITERS.READ]: limiter,
});

// Fixed-window counter shaped like a Cloudflare rate-limit binding.
export function counting(cap: number) {
  const counts = new Map<string, number>();
  const limiter: FakeLimiter = {
    async limit({ key }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= cap };
    },
  };
  return { counts, limiter };
}

// In-memory stand-in for the Workers Cache API (caches.default).
export function memoryCache() {
  const entries = new Map<string, Response>();
  const puts: string[] = [];
  const matches: string[] = [];
  const cache: ResponseCache = {
    async match(key) {
      matches.push(key);
      return entries.get(key)?.clone();
    },
    async put(key, response) {
      puts.push(key);
      entries.set(key, response.clone());
    },
  };
  return { cache, entries, puts, matches };
}

function signWith(
  privateKey: KeyObject,
  record: PublicRecordV2,
): SignedPublicV2 {
  const bytes = signingBytes(PUBLIC_V2_DOMAINS[record.kind], record);
  return { record, signature: sign(null, bytes, privateKey).toString('hex') };
}

interface CatalogOptions {
  models?: string[];
  issuedAt?: number;
}

// One synthetic node key; records are signed over the protocol's v2 signing bytes.
export function indexNode() {
  const keys = generateKeyPairSync('ed25519');
  const x = keys.publicKey.export({ format: 'jwk' }).x!;
  const nodeId = Buffer.from(x, 'base64url').toString('hex');
  const header = (sequence: number, issuedAt: number, lifetime: number) => ({
    schemaVersion: CONTROL_RECORD_VERSION as typeof CONTROL_RECORD_VERSION,
    owner: INDEX_OWNER,
    nodeId,
    sequence,
    issuedAt,
    expiresAt: issuedAt + lifetime,
  });
  const signed = (record: PublicRecordV2) => signWith(keys.privateKey, record);
  return {
    nodeId,
    sign: signed,
    catalog(
      sequence: number,
      { models = [MODEL], issuedAt = T0 }: CatalogOptions = {},
    ) {
      const record: PublicCatalogV2 = {
        ...header(sequence, issuedAt, 600_000),
        kind: PUBLIC_RECORD_KINDS.CATALOG,
        models: models.map((modelId) => ({
          modelId,
          variant: null,
          quantization: 'Q4_K_M',
          contextTokens: 2048,
          pricing: {
            network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            asset: '11111111111111111111111111111111',
            unit: V2_PRICING.unit,
            inputAtomicPerMtok: '0',
            outputAtomicPerMtok: '2',
          },
          reasoning: [REASONING_LEVELS.OFF],
        })),
        dataPolicy: { retention: DATA_RETENTION.NONE },
      };
      return signed(record);
    },
    async presence(
      sequence: number,
      catalog: SignedPublicV2,
      { issuedAt = T0 } = {},
    ) {
      return signed({
        ...header(sequence, issuedAt, 90_000),
        kind: PUBLIC_RECORD_KINDS.PRESENCE,
        catalogDigest: await catalogDigestV2(catalog.record),
        state: PUBLIC_PRESENCE_STATE,
      });
    },
    async withdrawal(
      sequence: number,
      catalog: SignedPublicV2,
      { issuedAt = T0 } = {},
    ) {
      return signed({
        ...header(sequence, issuedAt, 600_000),
        kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
        catalogDigest: await catalogDigestV2(catalog.record),
      });
    },
  };
}
export type IndexNode = ReturnType<typeof indexNode>;

// Records every stored entry, so tests can assert what was persisted.
export function recordingStorage(storage: DiscoveryStorage) {
  const entries: StoredEntry[] = [];
  const recording: DiscoveryStorage = {
    ...storage,
    put: async (entry) => {
      entries.push(entry);
      return storage.put(entry);
    },
  };
  return { storage: recording, entries };
}

export const HARNESS_KINDS = ['memory', 'sqlite-d1'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

async function storageOf(kind: HarnessKind) {
  if (kind === 'memory')
    return { storage: createMemoryStorage(), dump: () => '' };
  const db = await createSqliteD1();
  return db ? { storage: createD1Storage(db), dump: () => db.dump() } : null;
}

export interface PublishOptions {
  limiters?: Partial<Record<DiscoveryLimiterName, FakeLimiter>>;
  headers?: Record<string, string>;
  raw?: BodyInit;
}

// One app over one storage adapter, with a fake clock, open publishing unless overridden and
// per-request limiter overrides.
export async function indexHarness(
  kind: HarnessKind,
  options: DiscoveryIndexOptions = {},
) {
  const made = await storageOf(kind);
  if (!made) return null;
  const clock = { now: T0 + 1000 };
  const recorded = recordingStorage(made.storage);
  let current: Partial<Record<DiscoveryLimiterName, FakeLimiter>> = {};
  const switchable = (name: DiscoveryLimiterName): FakeLimiter => ({
    limit: (input) => (current[name] ?? allow).limit(input),
  });
  const app = createDiscoveryIndex({
    storage: recorded.storage,
    limiters: {
      [DISCOVERY_LIMITERS.IP]: switchable(DISCOVERY_LIMITERS.IP),
      [DISCOVERY_LIMITERS.PUBLISH]: switchable(DISCOVERY_LIMITERS.PUBLISH),
      [DISCOVERY_LIMITERS.NODE]: switchable(DISCOVERY_LIMITERS.NODE),
      [DISCOVERY_LIMITERS.READ]: switchable(DISCOVERY_LIMITERS.READ),
    },
    now: () => clock.now,
    publishers: { mode: PUBLISH_MODES.OPEN },
    ...options,
  });
  async function call(
    path: string,
    init: RequestInit = {},
    limiters: PublishOptions['limiters'] = {},
  ) {
    current = limiters;
    try {
      return await app.fetch(new Request(INDEX_ORIGIN + path, init));
    } finally {
      current = {};
    }
  }
  function publish(
    signed: unknown,
    { limiters, headers = {}, raw }: PublishOptions = {},
  ) {
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': CLIENT_IP,
        ...headers,
      },
      body: raw ?? JSON.stringify({ record: signed }),
      duplex: 'half',
    };
    return call('/v1/records', init, limiters);
  }
  async function sellers(query = `model=${MODEL}`) {
    const response = await call('/v1/sellers?' + query);
    const text = await response.text();
    return { response, text, body: JSON.parse(text) };
  }
  const dump = () => made.dump() + JSON.stringify(recorded.entries);
  return {
    app,
    clock,
    call,
    publish,
    sellers,
    dump,
    entries: recorded.entries,
  };
}
export type IndexHarness = NonNullable<
  Awaited<ReturnType<typeof indexHarness>>
>;

export async function expectError(
  response: Response,
  status: number,
  code: string,
) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: code });
}

// Registers one case per storage adapter; the D1 case skips only when node:sqlite is missing.
export function eachStorage(
  title: string,
  run: (harness: IndexHarness) => Promise<void>,
  options: DiscoveryIndexOptions = {},
) {
  for (const kind of HARNESS_KINDS)
    void test(`${kind}: ${title}`, async (context) => {
      const harness = await indexHarness(kind, options);
      if (!harness) {
        context.skip('node:sqlite unavailable');
        return;
      }
      await run(harness);
    });
}
