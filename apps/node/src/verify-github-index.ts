// The index side of `gyblos seller verify github`: signing and posting claims (a stale answer re-signed once,
// a short CHECK_DEFERRED waited out once), reading this seller's claim back, `--status` and `--cancel`, saving
// progress, and the plain-English text for each answer. Failures lead with a sentence saying what to do and
// end with a static code in brackets. Prints only public identifiers.
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
import { ControlError } from '@gyblos/protocol/control-validation';
import {
  IDENTITY_CLAIM,
  IDENTITY_CLAIM_KINDS,
  signIdentityClaim,
} from '@gyblos/protocol/identity-claim';

import { urlOrigin } from './cli-format';
import type { Prompt } from './cli-init';
import { EXIT, VERIFY_ERRORS, VERIFY_GITHUB, VERIFY_STEPS } from './constants';
import type { GistTool } from './gist-tool';
import {
  clearProgress,
  gistWebUrl,
  readProgress,
  writeProgress,
  type VerifyProgress,
} from './github-verification';
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

const AGAIN = 'Run the same command again';
// Why a claim is not verified, and what to do, by the index's reason.
export const REASON_TEXT: Readonly<Record<GithubClaimReason, string>> = {
  [GITHUB_CLAIM_REASONS.GIST_NOT_FOUND]:
    'GitHub has no public gist with that id owned by this account. Check the account name and that the gist is public',
  [GITHUB_CLAIM_REASONS.NODE_ID_MISSING]:
    'the gist does not contain the proof line. Add it on a line of its own, then run the same command again',
  [GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE]: `the index could not reach GitHub. ${AGAIN} in a few minutes`,
  [GITHUB_CLAIM_REASONS.CHECK_DEFERRED]: `the index checked this seller moments ago. ${AGAIN} in a minute`,
};
const INDEX_HINTS: ReadonlyMap<string, string> = new Map([
  [
    DISCOVERY_ERROR_CODES.UNKNOWN_NODE,
    'The index does not know this seller yet. Register it with `gyblos seller register`, or start it with publishing on, then run the same command again',
  ],
  [
    DISCOVERY_ERROR_CODES.RATE_LIMITED,
    'The index got too many attempts. Wait a minute and run the same command again',
  ],
  [
    DISCOVERY_ERROR_CODES.UNAVAILABLE,
    `The index does not take GitHub claims right now. ${AGAIN} later`,
  ],
  [
    DISCOVERY_ERROR_CODES.STALE_CLAIM,
    "The index holds a newer claim from this seller. Check this computer's clock, then run the same command again",
  ],
  [
    DISCOVERY_ERROR_CODES.CLAIM_REJECTED,
    "The index refused the claim. Check this computer's clock, then run the same command again",
  ],
  [
    DISCOVERY_ERROR_CODES.INVALID_SIGNATURE,
    'The index refused the signature. Run `gyblos doctor`',
  ],
  [
    DISCOVERY_ERROR_CODES.HTTP_STATUS,
    'This index does not take GitHub claims. Check discovery.url in config.toml',
  ],
  [
    DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
    'The index sent an answer this version cannot read. Update gyblos, or try again later',
  ],
]);
export const RETRY_LATER = `The index could not answer. ${AGAIN} in a few minutes`;

export interface Session {
  output: SellerOutput;
  system: VerifySystem;
  environment: SellerOutput['env'];
  nodeId: string;
  baseUrl: string;
  now: () => number;
}

// One line: what happened and what to do, then the static code for support.
export function fail(output: SellerOutput, code: string, message: string) {
  output.stderr(`${message}. [${code}]\n`);
  return EXIT.failure;
}

// The node key could not be read, or what it signed does not match this seller's NodeId.
class SigningFailed extends Error {}

export function indexFailure(session: Session, error: unknown) {
  if (error instanceof SigningFailed)
    return fail(
      session.output,
      VERIFY_ERRORS.SIGNING_FAILED,
      "This seller's node key could not sign the claim. Run `gyblos doctor`",
    );
  if (!(error instanceof DiscoveryError)) throw error;
  return fail(
    session.output,
    error.code,
    INDEX_HINTS.get(error.code) ?? RETRY_LATER,
  );
}

// Saves progress; false after printing why it could not.
export async function saveProgress(
  session: Session,
  progress: Omit<VerifyProgress, 'nodeId'>,
) {
  try {
    await writeProgress(session.environment, {
      nodeId: session.nodeId,
      ...progress,
    });
    return true;
  } catch {
    fail(
      session.output,
      VERIFY_ERRORS.STATE_FAILED,
      'Could not save progress in the seller home. Check that the seller directory is yours and writable (`gyblos doctor`), then run the same command again',
    );
    return false;
  }
}

const iso = (time: number) =>
  new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');

async function signer(session: Session) {
  try {
    return await nodeKeySigner(P2P_ROLES.SELLER, session.environment);
  } catch {
    throw new SigningFailed();
  }
}
async function signClaim(
  session: Session,
  sign: Awaited<ReturnType<typeof signer>>,
  account: string | null,
  gist: string | null,
  issuedAt: number,
) {
  try {
    return await signIdentityClaim(
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
  } catch (error) {
    if (error instanceof ControlError) throw new SigningFailed();
    throw error;
  }
}

// Signs and posts one claim; a stale answer is re-signed once with a fresh time, and a short
// CHECK_DEFERRED is waited out once.
export async function post(
  session: Session,
  account: string | null,
  gist: string | null,
): Promise<GithubClaimAnswer> {
  const sign = await signer(session);
  let issuedAt = session.now();
  let resigned = false;
  let waited = false;
  for (;;) {
    const signed = await signClaim(session, sign, account, gist, issuedAt);
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
  const where = `seller ${session.nodeId} in ${urlOrigin(session.baseUrl)}`;
  if (view)
    session.output.stdout(`GitHub claim for ${where}:\n${viewLines(view)}`);
  else session.output.stdout(`No GitHub claim for ${where}.\n`);
  if (
    progress &&
    progress.step !== VERIFY_STEPS.VERIFIED &&
    view?.state !== GITHUB_CLAIM_STATES.VERIFIED
  )
    session.output.stdout(
      `  In progress here: ${progress.account}. Run \`gyblos seller verify github ${progress.account}\` to continue.\n`,
    );
  return EXIT.ok;
}

// Local progress is cleared only once the index has accepted the cancel.
export async function cancel(session: Session) {
  let answer: GithubClaimAnswer;
  try {
    answer = await post(session, null, null);
  } catch (error) {
    return indexFailure(session, error);
  }
  if (answer.state !== null)
    return fail(session.output, VERIFY_ERRORS.NOT_VERIFIED, RETRY_LATER);
  const progress = await readProgress(session.environment, session.nodeId);
  await clearProgress(session.environment).catch(() => undefined);
  const gist = progress?.gist
    ? ` The gist ${gistWebUrl(progress.account, progress.gist)} is still on GitHub; delete it yourself if you no longer want it.`
    : ' Any proof gist is still on GitHub; delete it yourself if you no longer want it.';
  session.output.stdout(
    `Cancelled: the index no longer links this seller to a GitHub account.${gist}\n`,
  );
  return EXIT.ok;
}
