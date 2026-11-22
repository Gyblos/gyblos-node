// Sends a node-signed GitHub claim to an untrusted index (POST /identity/github) and reads one NodeId's
// claim back (GET /identity/github/<nodeId>). Signing belongs to the caller; this client only checks the
// answers' shape. What the index reports is its own check of the gist, not proof on its own.
import { HTTP_STATUS as CONFIG_HTTP_STATUS } from '@gyblos/config';
import {
  IDENTITY_CLAIM,
  type SignedIdentityClaim,
} from '@gyblos/protocol/identity-claim';

import {
  CLAIM_ERROR_MAP,
  DISCOVERY_ERROR_CODES,
  DISCOVERY_LIMITS,
  DISCOVERY_PATHS,
  GITHUB_CLAIM_REASONS,
  GITHUB_CLAIM_STATES,
  HTTP_STATUS,
  REGISTRATION_FORMAT,
  STATUS_ERROR_MAP,
  type GithubClaimReason,
  type GithubClaimState,
} from './constants';
import { discoveryFail } from './errors';
import {
  failStatus,
  indexUrl,
  isDeadlineError,
  isPlainObject,
  readJson,
  rejectionCode,
  timeoutOf,
  withDeadline,
  type DiscoveryFetch,
} from './http';

interface ClaimRequest {
  baseUrl: string;
  fetch: DiscoveryFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface SubmitGithubClaimInput extends ClaimRequest {
  signed: SignedIdentityClaim;
}
export interface FetchGithubClaimInput extends ClaimRequest {
  nodeId: string;
}

// The index's answer to a POST: the state after it (null after a cancel), the stored reason or
// CHECK_DEFERRED, and with CHECK_DEFERRED the seconds until a POST may fetch the gist again.
export interface GithubClaimAnswer {
  state: GithubClaimState | null;
  reason: GithubClaimReason | null;
  retryAfter?: number;
}
export interface GithubClaimView {
  nodeId: string;
  account: string;
  gist: string;
  state: GithubClaimState;
  reason: GithubClaimReason | null;
  checkedAt: number | null;
  verifiedAt: number | null;
}

// 409 is a stale claim here, not a stale record.
const CLAIM_STATUS_ERROR_MAP: ReadonlyMap<
  number,
  (typeof DISCOVERY_ERROR_CODES)[keyof typeof DISCOVERY_ERROR_CODES]
> = new Map([
  ...STATUS_ERROR_MAP,
  [HTTP_STATUS.CONFLICT, DISCOVERY_ERROR_CODES.STALE_CLAIM],
]);
const isRefusal = (status: number) =>
  status === HTTP_STATUS.BAD_REQUEST || status === HTTP_STATUS.FORBIDDEN;

const stateOf = (value: unknown) =>
  Object.values(GITHUB_CLAIM_STATES).find((state) => state === value);
const reasonOf = (value: unknown) =>
  Object.values(GITHUB_CLAIM_REASONS).find((reason) => reason === value);
// The index's account and gist must be what a claim may carry: anything else (an escape sequence, a
// newline) never reaches a terminal.
const githubAccount = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= IDENTITY_CLAIM.maxAccountCharacters &&
  IDENTITY_CLAIM.githubAccount.test(value);
const gistId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= IDENTITY_CLAIM.maxGistCharacters &&
  IDENTITY_CLAIM.gistId.test(value);
const time = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

function malformed(): never {
  return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
}

function checkAnswer(body: unknown): GithubClaimAnswer {
  const keys = isPlainObject(body, ['ok', 'state', 'reason', 'retryAfter'])
    ? ['ok', 'state', 'reason', 'retryAfter']
    : ['ok', 'state', 'reason'];
  if (!isPlainObject(body, keys) || body.ok !== true) return malformed();
  const state =
    body.state === null ? null : (stateOf(body.state) ?? malformed());
  const reason =
    body.reason === null ? null : (reasonOf(body.reason) ?? malformed());
  if (!('retryAfter' in body)) return { state, reason };
  const retryAfter = body.retryAfter;
  if (
    reason !== GITHUB_CLAIM_REASONS.CHECK_DEFERRED ||
    typeof retryAfter !== 'number' ||
    !Number.isSafeInteger(retryAfter) ||
    retryAfter < 1 ||
    retryAfter > DISCOVERY_LIMITS.maxRetryAfterSeconds
  )
    return malformed();
  return { state, reason, retryAfter };
}

async function readAnswer(
  response: Response,
  aborted: Promise<never>,
): Promise<GithubClaimAnswer> {
  const mapped = CLAIM_STATUS_ERROR_MAP.get(response.status);
  if (mapped) failStatus(response, mapped);
  if (response.status !== HTTP_STATUS.OK && !isRefusal(response.status))
    failStatus(response, DISCOVERY_ERROR_CODES.HTTP_STATUS);
  let body: unknown;
  try {
    body = await readJson(
      response,
      DISCOVERY_LIMITS.maxClaimResponseBytes,
      aborted,
    );
  } catch (error) {
    if (isRefusal(response.status) && !isDeadlineError(error))
      discoveryFail(DISCOVERY_ERROR_CODES.CLAIM_REJECTED, response.status);
    throw error;
  }
  if (isRefusal(response.status))
    discoveryFail(
      rejectionCode(
        body,
        CLAIM_ERROR_MAP,
        DISCOVERY_ERROR_CODES.CLAIM_REJECTED,
      ),
      response.status,
    );
  return checkAnswer(body);
}

export async function submitGithubClaim(
  input: SubmitGithubClaimInput,
): Promise<GithubClaimAnswer> {
  const request = {
    url: indexUrl(input.baseUrl, DISCOVERY_PATHS.githubIdentity),
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(input.signed),
    },
    fetch: input.fetch,
    timeoutMs: timeoutOf(input.timeoutMs),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  return withDeadline(request, readAnswer);
}

const VIEW_KEYS = [
  'nodeId',
  'account',
  'gist',
  'state',
  'reason',
  'checkedAt',
  'verifiedAt',
] as const;

function checkView(body: unknown, nodeId: string): GithubClaimView {
  if (!isPlainObject(body, VIEW_KEYS)) return malformed();
  const { account, gist, checkedAt, verifiedAt } = body;
  const state = stateOf(body.state);
  const reason = body.reason === null ? null : reasonOf(body.reason);
  if (
    body.nodeId !== nodeId ||
    !githubAccount(account) ||
    !gistId(gist) ||
    !state ||
    reason === undefined ||
    !time(checkedAt) ||
    !time(verifiedAt)
  )
    return malformed();
  return { nodeId, account, gist, state, reason, checkedAt, verifiedAt };
}

// The NodeId's claim, or null when the index has none (or a cancelled one).
export async function fetchGithubClaim(
  input: FetchGithubClaimInput,
): Promise<GithubClaimView | null> {
  if (!REGISTRATION_FORMAT.nodeId.test(input.nodeId))
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const request = {
    url: indexUrl(
      input.baseUrl,
      DISCOVERY_PATHS.githubIdentity,
      `/${input.nodeId}`,
    ),
    init: { method: 'GET', headers: { accept: 'application/json' } },
    fetch: input.fetch,
    timeoutMs: timeoutOf(input.timeoutMs),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  return withDeadline(request, async (response, aborted) => {
    if (response.status === CONFIG_HTTP_STATUS.notFound) {
      response.body?.cancel().catch(() => {});
      return null;
    }
    if (response.status !== HTTP_STATUS.OK)
      failStatus(
        response,
        STATUS_ERROR_MAP.get(response.status) ??
          DISCOVERY_ERROR_CODES.HTTP_STATUS,
      );
    const body = await readJson(
      response,
      DISCOVERY_LIMITS.maxClaimResponseBytes,
      aborted,
    );
    return checkView(body, input.nodeId);
  });
}
