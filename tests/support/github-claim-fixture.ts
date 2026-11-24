// Owns synthetic harnesses for seller GitHub claims at the discovery index: a memory or SQLite-backed D1
// claim store beside the record and registration stores, a scripted fake gist fetcher that records every
// request, and node-signed claims from ephemeral unfunded keys. No GitHub, network or key file is used.
import assert from 'node:assert/strict';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { PUBLISH_MODES } from '@gyblos/discovery-index/constants';
import {
  createMemoryGithubClaimStore,
  type GithubClaimStore,
} from '@gyblos/discovery-index/github-claim-store';
import { createD1GithubClaimStore } from '@gyblos/discovery-index/github-claim-store-d1';
import type { GistFetch } from '@gyblos/discovery-index/github-gist';
import {
  createMemoryRegistrationStore,
  type RegistrationStore,
} from '@gyblos/discovery-index/registration-store';
import { createD1RegistrationStore } from '@gyblos/discovery-index/registration-store-d1';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import {
  githubProofLine,
  IDENTITY_CLAIM,
  IDENTITY_CLAIM_KINDS,
  signIdentityClaim,
  type IdentityClaimV1,
} from '@gyblos/protocol/identity-claim';

import { createSqliteD1, type SqliteD1 } from './d1-sqlite';
import {
  allLimiters,
  INDEX_ORIGIN,
  T0,
  type FakeLimiter,
  type IndexNode,
} from './discovery-index-fixture';

export const GIST = '0123456789abcdef0123456789abcdef';
export const OTHER_GIST = 'fedcba9876543210fedc';
export const ACCOUNT = 'octo-cat';
export const SIGNATURE = 'ab'.repeat(64);

// What the fake GitHub answers: a status and body, or a thrown network error.
export type GistAnswer = { status: number; body?: string } | 'throw';

export function fakeGists(
  answer: (url: string) => GistAnswer = () => ({ status: 404 }),
) {
  const requests: { url: string; init: RequestInit }[] = [];
  let current = answer;
  const fetcher: GistFetch = async (url, init) => {
    requests.push({ url, init });
    const reply = current(url);
    if (reply === 'throw') throw new TypeError('network down');
    return new Response(reply.body ?? '', { status: reply.status });
  };
  return {
    fetcher,
    requests,
    answer(next: (url: string) => GistAnswer) {
      current = next;
    },
  };
}

// The proof file's raw URL: one fixed file name, so a gist with several files is read reliably. GitHub
// serves it only when the account owns the gist (checked live).
export const gistUrl = (account: string, gist: string) =>
  `https://gist.githubusercontent.com/${account}/${gist}/raw/gyblos-proof.txt`;

// A gist text with the NodeId's proof line among other lines, CRLF endings and padding.
export const proofText = (nodeId: string) =>
  `My Gyblos seller\r\n  ${githubProofLine(nodeId)}  \r\nthanks\r\n`;

export async function signedClaim(
  node: IndexNode,
  patch: Partial<IdentityClaimV1> = {},
) {
  const claim: IdentityClaimV1 = {
    schemaVersion: IDENTITY_CLAIM.schemaVersion,
    kind: IDENTITY_CLAIM_KINDS.GITHUB,
    nodeId: node.nodeId,
    account: ACCOUNT,
    gist: GIST,
    issuedAt: T0,
    ...patch,
  };
  return signIdentityClaim(claim, node.signer);
}

export const CLAIM_KINDS = ['memory', 'sqlite-d1'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export async function claimStoreOf(
  kind: ClaimKind,
): Promise<{ claims: GithubClaimStore; db: SqliteD1 | null } | null> {
  if (kind === 'memory')
    return { claims: createMemoryGithubClaimStore(), db: null };
  const db = await createSqliteD1();
  return db ? { claims: createD1GithubClaimStore(db), db } : null;
}

export async function claimHarness(
  kind: ClaimKind,
  {
    limiter,
    noClaims,
    gistFetch,
  }: { limiter?: FakeLimiter; noClaims?: boolean; gistFetch?: GistFetch } = {},
) {
  const made = await claimStoreOf(kind);
  if (!made) return null;
  const { claims, db } = made;
  const registrations: RegistrationStore = db
    ? createD1RegistrationStore(db)
    : createMemoryRegistrationStore();
  const gists = fakeGists();
  const clock = { now: T0 + 1000 };
  const app = createDiscoveryIndex({
    storage: db ? createD1Storage(db) : createMemoryStorage(),
    limiters: allLimiters(limiter),
    publishers: { mode: PUBLISH_MODES.OPEN },
    registrations,
    ...(noClaims ? {} : { claims, gistFetch: gistFetch ?? gists.fetcher }),
    now: () => clock.now,
  });
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(INDEX_ORIGIN + path, init));
  // Makes the node known with a stored catalog, online through a presence so /v1/network lists it.
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
  function post(
    body: unknown,
    headers: Record<string, string> = { 'Content-Type': 'application/json' },
  ) {
    return call('/v1/identity/github', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
  async function claim(node: IndexNode, patch: Partial<IdentityClaimV1> = {}) {
    const response = await post(
      await signedClaim(node, { issuedAt: clock.now, ...patch }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const read = (nodeId: string) => call(`/v1/identity/github/${nodeId}`);
  return {
    app,
    db,
    clock,
    claims,
    registrations,
    gists,
    call,
    publish,
    post,
    claim,
    read,
  };
}
