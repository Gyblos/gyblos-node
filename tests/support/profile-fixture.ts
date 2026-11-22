import assert from 'node:assert/strict';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { PUBLISH_MODES } from '@gyblos/discovery-index/constants';
import {
  createMemorySellerProfileStore,
  type SellerProfileStore,
} from '@gyblos/discovery-index/profile-store';
import { createD1SellerProfileStore } from '@gyblos/discovery-index/profile-store-d1';
import {
  createMemoryRegistrationStore,
  type RegistrationStore,
} from '@gyblos/discovery-index/registration-store';
import { createD1RegistrationStore } from '@gyblos/discovery-index/registration-store-d1';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import {
  PROFILE_CLAIM,
  signProfileClaim,
  type ProfileClaimV1,
} from '@gyblos/protocol/profile-claim';

import { createSqliteD1 } from './d1-sqlite';
import {
  allLimiters,
  INDEX_ORIGIN,
  T0,
  type FakeLimiter,
  type IndexNode,
} from './discovery-index-fixture';

export const KINDS = ['memory', 'sqlite-d1'] as const;
type Kind = (typeof KINDS)[number];
export const HOUR = 3_600_000;
export const NAME = 'Ada Lovelace';

export async function storesOf(kind: Kind) {
  if (kind === 'memory')
    return {
      db: null,
      profiles: createMemorySellerProfileStore(),
      registrations: createMemoryRegistrationStore(),
    };
  const db = await createSqliteD1();
  if (!db) return null;
  return {
    db,
    profiles: createD1SellerProfileStore(db),
    registrations: createD1RegistrationStore(db),
  };
}

export async function profileHarness(
  kind: Kind,
  {
    limiter,
    noProfiles,
    profiles: override,
  }: {
    limiter?: FakeLimiter;
    noProfiles?: boolean;
    profiles?: SellerProfileStore;
  } = {},
) {
  const made = await storesOf(kind);
  if (!made) return null;
  const { db } = made;
  const revoked = new Set<string>();
  const registrations: RegistrationStore = {
    ...made.registrations,
    active: async (nodeId) =>
      !revoked.has(nodeId) && made.registrations.active(nodeId),
    registered: async (limit) => {
      const listed = await made.registrations.registered(limit);
      return {
        active: listed.active.filter((nodeId) => !revoked.has(nodeId)),
        revoked: [
          ...listed.revoked,
          ...listed.active.filter((nodeId) => revoked.has(nodeId)),
        ],
      };
    },
  };
  const profiles = override ?? made.profiles;
  const clock = { now: T0 + 1000 };
  const app = createDiscoveryIndex({
    storage: db ? createD1Storage(db) : createMemoryStorage(),
    limiters: allLimiters(limiter),
    publishers: { mode: PUBLISH_MODES.OPEN },
    registrations,
    ...(noProfiles ? {} : { profiles }),
    now: () => clock.now,
  });
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(INDEX_ORIGIN + path, init));
  async function publish(node: IndexNode) {
    const catalog = node.catalog(1, { issuedAt: clock.now });
    const presence = await node.presence(2, catalog, { issuedAt: clock.now });
    for (const record of [catalog, presence]) {
      const response = await call('/v1/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record }),
      });
      assert.equal(response.status, 201, await response.text());
    }
  }
  const post = (
    body: unknown,
    headers: Record<string, string> = { 'Content-Type': 'application/json' },
  ) =>
    call('/v1/profile', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const signed = (node: IndexNode, patch: Partial<ProfileClaimV1> = {}) =>
    signProfileClaim(
      {
        schemaVersion: PROFILE_CLAIM.schemaVersion,
        nodeId: node.nodeId,
        name: NAME,
        issuedAt: clock.now,
        ...patch,
      },
      node.signer,
    );
  async function name(node: IndexNode, patch: Partial<ProfileClaimV1> = {}) {
    const response = await post(await signed(node, patch));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const read = (nodeId: string) => call(`/v1/profile/${nodeId}`);
  const network = async () => (await call('/v1/network')).json();
  return {
    db,
    clock,
    call,
    revoked,
    profiles,
    registrations,
    publish,
    post,
    signed,
    name,
    read,
    network,
  };
}
