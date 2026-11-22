// The index side of `gyblos seller verify github`: signing and posting claims (a stale answer re-signed once,
// a short CHECK_DEFERRED waited out once), reading this seller's claim back, `--status` and `--cancel`, and
// the plain-English text for each index answer. Prints only public identifiers and static codes.
import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  fetchGithubClaim,
  GITHUB_CLAIM_REASONS,
  GITHUB_CLAIM_STATES,
  submitGithubClaim,
  type DiscoveryFetch,
  type GithubClaimAnswer,
  type GithubClaimReason,
  type GithubClaimView,
} from '@gyblos/discovery-http';
import { nodeKeySigner } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  IDENTITY_CLAIM,
  IDENTITY_CLAIM_KINDS,
  signIdentityClaim,
} from '@gyblos/protocol/identity-claim';

import { urlOrigin } from './cli-format';
import type { Prompt } from './cli-init';
import { EXIT, VERIFY_ERRORS, VERIFY_GITHUB } from './constants';
import type { GistTool } from './gist-tool';
import { clearProgress, gistWebUrl, readProgress } from './github-verification';
import type { SellerOutput } from './seller-home';

// What tests replace besides fetch and the prompt: the GitHub CLI, the clock and the wait.
export interface VerifyOptions {
  gist?: GistTool;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface VerifySystem extends VerifyOptions {
  fetch: DiscoveryFetch;
  prompt?: Prompt;
}

export const REASON_TEXT: Readonly<Record<GithubClaimReason, string>> = {
  [GITHUB_CLAIM_REASONS.GIST_NOT_FOUND]:
    'GitHub has no public gist with that id owned by this account; check the account name and that the gist is public',
  [GITHUB_CLAIM_REASONS.NODE_ID_MISSING]:
    'the gist does not contain the proof line; add it on a line of its own',
  [GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE]:
    'the index could not reach GitHub; the claim is saved as pending, run this again later',
  [GITHUB_CLAIM_REASONS.CHECK_DEFERRED]:
    'the index checked this seller less than a minute ago; run this again in a minute',
};
const INDEX_HINTS: ReadonlyMap<string, string> = new Map([
  [
    DISCOVERY_ERROR_CODES.UNKNOWN_NODE,
    'the index does not know this seller yet: register it with `gyblos seller register` or start it with publishing on, then run this again',
  ],
  [
    DISCOVERY_ERROR_CODES.RATE_LIMITED,
    'too many attempts; wait a minute and try again',
  ],
  [
    DISCOVERY_ERROR_CODES.UNAVAILABLE,
    'the index does not take GitHub claims now; try again later',
  ],
  [
    DISCOVERY_ERROR_CODES.STALE_CLAIM,
    "the index holds a newer claim from this seller; check this computer's clock and run this again",
  ],
  [
    DISCOVERY_ERROR_CODES.CLAIM_REJECTED,
    "the index refused the claim; check this computer's clock and run this again",
  ],
  [
    DISCOVERY_ERROR_CODES.INVALID_SIGNATURE,
    'the index refused the signature; run `gyblos doctor`',
  ],
]);
export const RETRY_LATER =
  'the index could not answer; try again in a few minutes';

export interface Session {
  output: SellerOutput;
  system: VerifySystem;
  environment: SellerOutput['env'];
  nodeId: string;
  baseUrl: string;
  now: () => number;
}

export function fail(output: SellerOutput, code: string, hint: string) {
  output.stderr(`${code}: ${hint}\n`);
  return EXIT.failure;
}
export function indexFailure(session: Session, error: unknown) {
  if (!(error instanceof DiscoveryError)) throw error;
  const hint =
    error.code === DISCOVERY_ERROR_CODES.HTTP_STATUS
      ? 'this index does not take GitHub claims; check discovery.url'
      : (INDEX_HINTS.get(error.code) ?? RETRY_LATER);
  return fail(session.output, error.code, hint);
}

const iso = (time: number) =>
  new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');

// Signs and posts one claim; a stale answer is re-signed once with a fresh time, and a short
// CHECK_DEFERRED is waited out once.
export async function post(
  session: Session,
  account: string | null,
  gist: string | null,
): Promise<GithubClaimAnswer> {
  const sign = await nodeKeySigner(P2P_ROLES.SELLER, session.environment);
  let issuedAt = session.now();
  let resigned = false;
  let waited = false;
  for (;;) {
    const signed = await signIdentityClaim(
      {
        schemaVersion: IDENTITY_CLAIM.schemaVersion,
        kind: IDENTITY_CLAIM_KINDS.GITHUB,
        nodeId: session.nodeId,
        account,
        gist,
        issuedAt,
      },
      sign,
    );
    let answer: GithubClaimAnswer;
    try {
      answer = await submitGithubClaim({
        baseUrl: session.baseUrl,
        signed,
        fetch: session.system.fetch,
        timeoutMs: VERIFY_GITHUB.indexTimeoutMs,
      });
    } catch (error) {
      if (
        resigned ||
        !(error instanceof DiscoveryError) ||
        error.code !== DISCOVERY_ERROR_CODES.STALE_CLAIM
      )
        throw error;
      resigned = true;
      issuedAt = Math.max(session.now(), issuedAt + 1);
      continue;
    }
    const wait = answer.retryAfter;
    if (
      answer.reason !== GITHUB_CLAIM_REASONS.CHECK_DEFERRED ||
      waited ||
      wait === undefined ||
      wait > VERIFY_GITHUB.maxWaitSeconds
    )
      return answer;
    waited = true;
    session.output.stdout(
      `The index checked this seller moments ago; waiting ${wait} s to ask again (Ctrl+C is safe).\n`,
    );
    await (session.system.sleep ?? sleep)(wait * VERIFY_GITHUB.msPerSecond);
    issuedAt = Math.max(session.now(), issuedAt + 1);
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function lookUp(session: Session) {
  return fetchGithubClaim({
    baseUrl: session.baseUrl,
    nodeId: session.nodeId,
    fetch: session.system.fetch,
    timeoutMs: VERIFY_GITHUB.indexTimeoutMs,
  });
}

function viewLines(view: GithubClaimView) {
  const reason = view.reason
    ? ` (${view.reason}: ${REASON_TEXT[view.reason]})`
    : '';
  return [
    `  account   ${view.account}\n`,
    `  gist      ${gistWebUrl(view.account, view.gist)}\n`,
    `  state     ${view.state}${reason}\n`,
    `  checked   ${view.checkedAt === null ? 'not yet' : iso(view.checkedAt)}\n`,
    ...(view.verifiedAt !== null && view.state === GITHUB_CLAIM_STATES.VERIFIED
      ? [`  verified  since ${iso(view.verifiedAt)}\n`]
      : []),
  ].join('');
}

export async function statusOf(session: Session) {
  let view: GithubClaimView | null;
  try {
    view = await lookUp(session);
  } catch (error) {
    return indexFailure(session, error);
  }
  const progress = await readProgress(session.environment, session.nodeId);
  if (!view) {
    session.output.stdout(
      `No GitHub claim for seller ${session.nodeId} in ${urlOrigin(session.baseUrl)}.\n`,
    );
    if (progress)
      session.output.stdout(
        `  In progress here: ${progress.account}; run \`gyblos seller verify github ${progress.account}\` to continue.\n`,
      );
    return EXIT.ok;
  }
  session.output.stdout(
    `GitHub claim for seller ${session.nodeId} in ${urlOrigin(session.baseUrl)}:\n${viewLines(view)}`,
  );
  return EXIT.ok;
}

export async function cancel(session: Session) {
  let answer: GithubClaimAnswer;
  try {
    answer = await post(session, null, null);
  } catch (error) {
    return indexFailure(session, error);
  }
  const progress = await readProgress(session.environment, session.nodeId);
  await clearProgress(session.environment);
  if (answer.state !== null)
    return fail(session.output, VERIFY_ERRORS.NOT_VERIFIED, RETRY_LATER);
  const gist = progress?.gist
    ? ` The gist ${gistWebUrl(progress.account, progress.gist)} is still on GitHub; delete it yourself if you no longer want it.`
    : ' Any proof gist is still on GitHub; delete it yourself if you no longer want it.';
  session.output.stdout(
    `Cancelled: the index no longer links this seller to a GitHub account.${gist}\n`,
  );
  return EXIT.ok;
}
