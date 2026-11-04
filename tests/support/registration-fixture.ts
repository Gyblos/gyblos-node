// Owns synthetic enrollment harnesses for the discovery index: a memory or SQLite-backed D1 registration
// store beside the record storage, a fake 8004 registry reader that counts its lookups, invites with
// known codes, and in-process requests. No RPC, chain, key file or network is touched.
import {
  IDENTITY_LOOKUP_FAILURES,
  IDENTITY_LOOKUP_KINDS,
} from '@gyblos/core/constants';
import type { IdentityLookup } from '@gyblos/core/identity-policy';
import {
  createDiscoveryIndex,
  type DiscoveryIndexOptions,
} from '@gyblos/discovery-index/app';
import { REGISTRATION } from '@gyblos/discovery-index/constants';
import {
  createMemoryRegistrationStore,
  type RegistrationStore,
} from '@gyblos/discovery-index/registration-store';
import { createD1RegistrationStore } from '@gyblos/discovery-index/registration-store-d1';
import { inviteHash } from '@gyblos/discovery-index/registrations';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';

import { createSqliteD1, type SqliteD1 } from './d1-sqlite';
import {
  allLimiters,
  INDEX_ORIGIN,
  T0,
  type FakeLimiter,
} from './discovery-index-fixture';

export const ASSET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
export const CHAIN_OWNER = 'HF7czidh6AtTmrAwa9S9obGXsvg7588CxSqEL3FQR2VS';
const SCOPE = {
  network: 'devnet',
  program: 'program',
  collection: 'collection',
};

let inviteCounter = 0;
// A well-formed invite code (gyb_ + 26 base32 characters), distinct per call.
export function inviteCode() {
  inviteCounter += 1;
  const digits = inviteCounter
    .toString(8)
    .split('')
    .map((digit) => String.fromCharCode(97 + Number(digit)))
    .join('');
  return `gyb_${digits.padStart(26, 'a')}`;
}

export type ChainAnswer = 'bound' | 'missing' | 'unavailable' | 'other-node';

export function fakeRegistry(answer: () => ChainAnswer = () => 'bound') {
  const lookups: string[] = [];
  return {
    lookups,
    reader: {
      async lookup(nodeId: string): Promise<IdentityLookup> {
        lookups.push(nodeId);
        const kind = answer();
        if (kind === 'missing')
          return { kind: IDENTITY_LOOKUP_KINDS.MISSING, nodeId, scope: SCOPE };
        if (kind === 'unavailable')
          return {
            kind: IDENTITY_LOOKUP_KINDS.UNAVAILABLE,
            nodeId,
            scope: SCOPE,
            reason: IDENTITY_LOOKUP_FAILURES.UNAVAILABLE,
          };
        return {
          kind: IDENTITY_LOOKUP_KINDS.BOUND,
          nodeId,
          scope: SCOPE,
          binding: {
            nodeId: kind === 'other-node' ? 'ff'.repeat(32) : nodeId,
            owner: CHAIN_OWNER,
            asset: ASSET,
            sequence: 1n,
          },
        };
      },
    },
  };
}

export const STORE_KINDS = ['memory', 'sqlite-d1'] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export async function enrollmentHarness(
  kind: StoreKind,
  options: DiscoveryIndexOptions & {
    limiter?: FakeLimiter;
    chain?: () => ChainAnswer;
  } = {},
) {
  let db: SqliteD1 | null = null;
  if (kind === 'sqlite-d1') {
    db = await createSqliteD1();
    if (!db) return null;
  }
  const memory = kind === 'memory' ? createMemoryRegistrationStore() : null;
  const registrations: RegistrationStore = db
    ? createD1RegistrationStore(db)
    : memory!;
  const registry = fakeRegistry(options.chain);
  const clock = { now: T0 + 1000 };
  const app = createDiscoveryIndex({
    storage: db ? createD1Storage(db) : createMemoryStorage(),
    limiters: allLimiters(options.limiter),
    registrations,
    registry: registry.reader,
    now: () => clock.now,
    ...options,
  });
  async function invite(
    contact = 'seller@example.com',
    lifetime: number = REGISTRATION.inviteLifetimeMs,
  ) {
    const code = inviteCode();
    await registrations.createInvite({
      inviteHash: await inviteHash(code),
      contact,
      createdAt: clock.now,
      expiresAt: clock.now + lifetime,
    });
    return code;
  }
  async function register(
    body: unknown,
    headers: Record<string, string> = { 'Content-Type': 'application/json' },
    cf?: Record<string, unknown>,
  ) {
    const request = new Request(`${INDEX_ORIGIN}/v1/registrations`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (cf) Object.defineProperty(request, 'cf', { value: cf });
    return app.fetch(request);
  }
  async function revoke(nodeId: string) {
    if (memory) memory.revoke(nodeId);
    else
      await db!
        .prepare(
          `UPDATE discovery_registrations SET status = 'revoked' WHERE node_id = ?1`,
        )
        .bind(nodeId)
        .run();
  }
  return { app, db, clock, registry, registrations, invite, register, revoke };
}
