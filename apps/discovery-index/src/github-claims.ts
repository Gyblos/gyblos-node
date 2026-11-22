// Owns seller GitHub claims at the index: POST /v1/identity/github admits a node-signed claim from a
// seller the index knows, stores it and checks its gist; the scheduled run checks due claims; GET
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
  type RecordedCheck,
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

// The answer to a POST: the state after it (null after a cancel) and the stored reason, or
// CHECK_DEFERRED with `retryAfter`, the seconds until a POST may fetch the gist again.
export interface GithubClaimResult {
  state: GithubClaimState | null;
  reason: GithubClaimReason | null;
  retryAfter?: number;
}

// A pending claim never verified and issued this long ago is no longer scheduled.
function abandoned(row: GithubClaimRow, check: GithubCheck, now: number) {
  return (
    check.state === GITHUB_CLAIM_STATES.PENDING &&
    check.verifiedAt === null &&
    row.issuedAt <= now - GITHUB_CLAIM.abandonPendingAfterMs
  );
}

// The stored state after a check that started at `now` with `outcome` (null: proof found). An outage
// keeps the state; a pending claim then stores GITHUB_UNAVAILABLE, a verified or lost one its reason.
export function nextCheck(
  row: GithubClaimRow,
  outcome: GistOutcome,
  now: number,
): RecordedCheck {
  let check: GithubCheck;
  if (outcome === null)
    check = {
      ...row,
      state: GITHUB_CLAIM_STATES.VERIFIED,
      reason: null,
      verifiedAt:
        row.state === GITHUB_CLAIM_STATES.VERIFIED && row.verifiedAt !== null
          ? row.verifiedAt
          : now,
    };
  else if (outcome === GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE)
    check =
      row.state === GITHUB_CLAIM_STATES.PENDING
        ? { ...row, reason: outcome }
        : row;
  else
    check = {
      ...row,
      state:
        row.verifiedAt === null
          ? GITHUB_CLAIM_STATES.PENDING
          : GITHUB_CLAIM_STATES.LOST,
      reason: outcome,
    };
  return {
    state: check.state,
    reason: check.reason,
    verifiedAt: check.verifiedAt,
    checkedAt: now,
    nextCheckAt: abandoned(row, check, now)
      ? null
      : now + GITHUB_CLAIM.recheckAfterMs,
  };
}

// Checks the stored claim's gist and records the outcome against that exact claim. A conclusive outcome is
// written only onto the snapshot it was computed from; an inconclusive one only moves checked_at forward.
// The answer is what storage holds afterwards, so a POST never reports a state that lost a race.
async function check(
  claims: GithubClaimStore,
  fetcher: GistFetch,
  row: GithubClaimRow,
  now: number,
): Promise<GithubClaimResult> {
  const outcome = await checkGist(fetcher, row);
  const next = nextCheck(row, outcome, now);
  if (outcome !== GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE) {
    if (await claims.record(row.nodeId, row.issuedAt, row.checkedAt, next))
      return { state: next.state, reason: next.reason };
  } else await claims.touch(row.nodeId, row.issuedAt, now, next.nextCheckAt);
  // Another check landed first, or an outage left the stored state as it is: answer what is stored.
  const stored = await claims.get(row.nodeId);
  return stored?.state != null && stored.issuedAt === row.issuedAt
    ? { state: stored.state, reason: stored.reason }
    : { state: next.state, reason: next.reason };
}

// A seller the index already knows: an active registration or a stored catalog.
async function known(context: GithubClaimContext, nodeId: string) {
  if (await context.registrations?.active(nodeId)) return true;
  return !!(await context.storage.state(nodeId))?.catalog;
}

async function verifiedClaim(bytes: ArrayBuffer, now: number) {
  const code = INDEX_ERRORS.INVALID_CLAIM;
  const body = parseJson(decodeUtf8(bytes, code), code);
  const { claim } = await protocolStep(
    () => verifyIdentityClaim(body),
    (failure) =>
      failure === CONTROL_CODES.SIGNATURE
        ? INDEX_ERRORS.INVALID_SIGNATURE
        : code,
  );
  if (claim.issuedAt > now + CONTROL_LIMITS.clockSkewMs) indexFail(code);
  if (claim.issuedAt < now - GITHUB_CLAIM.maxAgeMs)
    indexFail(INDEX_ERRORS.STALE_CLAIM);
  return claim;
}

// Throws IndexError with a static code; storage failures propagate (503). A cancel needs no known
// seller (a NodeId the index forgot can still withdraw its claim); a new binding does. A cancel with
// nothing stored from a NodeId the index does not know writes nothing.
export async function submitGithubClaim(
  bytes: ArrayBuffer,
  context: GithubClaimContext,
): Promise<GithubClaimResult> {
  const { claims, now } = context;
  const claim = await verifiedClaim(bytes, now);
  const stored = await claims.get(claim.nodeId);
  if (stored && stored.issuedAt >= claim.issuedAt)
    indexFail(INDEX_ERRORS.STALE_CLAIM);
  if (claim.account === null || claim.gist === null) {
    if (!stored && !(await known(context, claim.nodeId)))
      return { state: null, reason: null };
    if (!(await claims.put(githubClaimTombstone(claim.nodeId, claim.issuedAt))))
      indexFail(INDEX_ERRORS.STALE_CLAIM);
    return { state: null, reason: null };
  }
  if (!(await known(context, claim.nodeId)))
    indexFail(INDEX_ERRORS.UNKNOWN_NODE);
  // The same account and gist keep their state (idempotent); a new binding starts over. Either is due
  // for the next scheduled run until a check lands.
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
    nextCheckAt: now,
  };
  if (!(await claims.put(row))) indexFail(INDEX_ERRORS.STALE_CLAIM);
  const wait = await claims.reserveFetch(
    row.nodeId,
    row.issuedAt,
    now,
    GITHUB_CLAIM.minFetchIntervalMs,
  );
  if (wait > 0)
    return {
      state: row.state,
      reason: GITHUB_CLAIM_REASONS.CHECK_DEFERRED,
      retryAfter: Math.ceil(wait / GITHUB_CLAIM.msPerSecond),
    };
  return check(claims, context.fetch, row, now);
}

// One scheduled batch: the claims due soonest, one gist at a time so a run never holds more than one
// request to GitHub. Returns how many were checked.
export async function recheckGithubClaims(
  claims: GithubClaimStore,
  fetcher: GistFetch,
  now: number,
) {
  const due = await claims.due(now, GITHUB_CLAIM.recheckBatch);
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
