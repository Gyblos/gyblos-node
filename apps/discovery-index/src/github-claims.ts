// Owns seller GitHub claims at the index: POST /v1/identity/github admits a node-signed claim from a
// seller the index knows, stores it and checks its gist; the scheduled run rechecks old checks; GET
// /v1/identity/github/<nodeId> reads one. The claim is never part of a public record. States move only
// on conclusive checks: an outage keeps the state and moves checked_at alone. A cancel keeps a
// tombstone, and POSTs fetch a NodeId's gist at most once per GITHUB_CLAIM.minFetchIntervalMs.
import { CONTROL_CODES, CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { verifyIdentityClaim } from '@gyblos/protocol/identity-claim';

import { decodeUtf8, parseJson } from './body';
import {
  GITHUB_CLAIM,
  GITHUB_CLAIM_REASONS,
  GITHUB_CLAIM_STATES,
  INDEX_ERRORS,
  REGISTRATION,
  type GithubClaimReason,
  type GithubClaimState,
} from './constants';
import { indexFail, protocolStep } from './errors';
import {
  githubClaimTombstone,
  type GithubCheck,
  type GithubClaimRow,
  type GithubClaimStore,
} from './github-claim-store';
import { checkGist, type GistFetch, type GistOutcome } from './github-gist';
import type { RegistrationStore } from './registration-store';
import type { DiscoveryStorage } from './storage';

export interface GithubClaimContext {
  claims: GithubClaimStore;
  storage: DiscoveryStorage;
  registrations: RegistrationStore | undefined;
  fetch: GistFetch;
  now: number;
}

// The answer to a POST: the state after the check (null after a cancel) and the check's own reason.
export interface GithubClaimResult {
  state: GithubClaimState | null;
  reason: GithubClaimReason | null;
}

// The stored state after a check whose outcome is `reason` (null: proof found).
export function nextCheck(
  row: GithubCheck,
  reason: GistOutcome,
  now: number,
): GithubCheck {
  if (reason === null)
    return {
      state: GITHUB_CLAIM_STATES.VERIFIED,
      reason: null,
      checkedAt: now,
      verifiedAt:
        row.state === GITHUB_CLAIM_STATES.VERIFIED && row.verifiedAt !== null
          ? row.verifiedAt
          : now,
    };
  if (reason === GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE)
    return { ...row, checkedAt: now };
  return {
    state:
      row.verifiedAt === null
        ? GITHUB_CLAIM_STATES.PENDING
        : GITHUB_CLAIM_STATES.LOST,
    reason,
    checkedAt: now,
    verifiedAt: row.verifiedAt,
  };
}

// Checks the stored claim's gist and records the outcome against that exact claim.
async function check(
  claims: GithubClaimStore,
  fetcher: GistFetch,
  row: GithubClaimRow,
  now: number,
) {
  const reason = await checkGist(fetcher, row);
  const next = nextCheck(row, reason, now);
  await claims.record(row.nodeId, row.issuedAt, next);
  return { state: next.state, reason };
}

// A seller the index already knows: an active registration or a stored catalog.
async function known(context: GithubClaimContext, nodeId: string) {
  if (await context.registrations?.active(nodeId)) return true;
  return !!(await context.storage.state(nodeId))?.catalog;
}

// Throws IndexError with a static code; storage failures propagate (503).
export async function submitGithubClaim(
  bytes: ArrayBuffer,
  context: GithubClaimContext,
): Promise<GithubClaimResult> {
  const code = INDEX_ERRORS.INVALID_CLAIM;
  const body = parseJson(decodeUtf8(bytes, code), code);
  const { claim } = await protocolStep(
    () => verifyIdentityClaim(body),
    (failure) =>
      failure === CONTROL_CODES.SIGNATURE
        ? INDEX_ERRORS.INVALID_SIGNATURE
        : code,
  );
  const { claims, now } = context;
  if (claim.issuedAt > now + CONTROL_LIMITS.clockSkewMs) indexFail(code);
  if (claim.issuedAt < now - GITHUB_CLAIM.maxAgeMs)
    indexFail(INDEX_ERRORS.STALE_CLAIM);
  if (!(await known(context, claim.nodeId)))
    indexFail(INDEX_ERRORS.UNKNOWN_NODE);
  const stored = await claims.get(claim.nodeId);
  if (stored && stored.issuedAt >= claim.issuedAt)
    indexFail(INDEX_ERRORS.STALE_CLAIM);
  if (claim.account === null || claim.gist === null) {
    if (!(await claims.put(githubClaimTombstone(claim.nodeId, claim.issuedAt))))
      indexFail(INDEX_ERRORS.STALE_CLAIM);
    return { state: null, reason: null };
  }
  // The same account and gist keep their state (idempotent); a new binding starts over.
  const same =
    stored?.state != null &&
    stored.account === claim.account &&
    stored.gist === claim.gist
      ? stored
      : null;
  const row: GithubClaimRow = {
    nodeId: claim.nodeId,
    account: claim.account,
    gist: claim.gist,
    issuedAt: claim.issuedAt,
    state: same?.state ?? GITHUB_CLAIM_STATES.PENDING,
    reason: same?.reason ?? null,
    checkedAt: same?.checkedAt ?? null,
    verifiedAt: same?.verifiedAt ?? null,
  };
  if (!(await claims.put(row))) indexFail(INDEX_ERRORS.STALE_CLAIM);
  const reserved = await claims.reserveFetch(
    row.nodeId,
    row.issuedAt,
    now,
    GITHUB_CLAIM.minFetchIntervalMs,
  );
  if (!reserved)
    return { state: row.state, reason: GITHUB_CLAIM_REASONS.CHECK_DEFERRED };
  return check(claims, context.fetch, row, now);
}

// One scheduled batch: the least recently checked claims older than GITHUB_CLAIM.recheckAfterMs, one
// gist at a time so a run never holds more than one request to GitHub. Returns how many were checked.
export async function recheckGithubClaims(
  claims: GithubClaimStore,
  fetcher: GistFetch,
  now: number,
) {
  const due = await claims.due(
    now - GITHUB_CLAIM.recheckAfterMs,
    GITHUB_CLAIM.recheckBatch,
  );
  for (const row of due) await check(claims, fetcher, row, now);
  return due.length;
}

export function parseGithubClaimPath(url: string, nodeId: string | undefined) {
  if (
    new URL(url).search !== '' ||
    nodeId === undefined ||
    !REGISTRATION.nodeId.test(nodeId)
  )
    return indexFail(INDEX_ERRORS.INVALID_QUERY);
  return nodeId;
}

// The public view of one claim, or null (404) when the NodeId has none or cancelled it.
export async function githubClaimPage(
  claims: GithubClaimStore,
  nodeId: string,
): Promise<string | null> {
  const row = await claims.get(nodeId);
  if (!row || row.state === null) return null;
  const { account, gist, state, reason, checkedAt, verifiedAt } = row;
  return JSON.stringify({
    nodeId,
    account,
    gist,
    state,
    reason,
    checkedAt,
    verifiedAt,
  });
}
