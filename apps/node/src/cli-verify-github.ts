// `gyblos seller verify github <user> [--gist <url|id>]`, `--status` and `--cancel`: links this seller to a
// GitHub account. A gist owned by the account (public or unlisted; its id becomes public) holds the NodeId's
// proof line in gyblos-proof.txt, and the node key signs a
// claim naming the account and gist, which the discovery index checks. Resumable: each step is saved to a
// private progress file, and each run first checks the index and the gist, so Ctrl+C is safe anywhere.
// Prints only public identifiers (NodeId, account, gist URL, index origin); never a key or the home path.
import { parseArgs } from 'node:util';

import { runMode } from '@gyblos/config';
import {
  GITHUB_CLAIM_REASONS,
  GITHUB_CLAIM_STATES,
  type DiscoveryFetch,
  type GithubClaimAnswer,
  type GithubClaimView,
} from '@gyblos/discovery-http';
import {
  githubProofLine,
  IDENTITY_CLAIM,
} from '@gyblos/protocol/identity-claim';

import { urlOrigin } from './cli-format';
import type { Prompt } from './cli-init';
import { commandsFor } from './cli-next';
import {
  EXIT,
  GIST_CHECKS,
  GIST_SOURCES,
  VERIFY_ERRORS,
  VERIFY_STEPS,
} from './constants';
import {
  checkGist,
  gistWebUrl,
  readProgress,
  validAccount,
} from './github-verification';
import {
  discoverySettings,
  homeEnvironmentOf,
  sellerIdentity,
  type SellerOutput,
} from './seller-home';
import { gistFor, type ChosenGist } from './verify-github-gist';
import {
  cancel,
  fail,
  indexFailure,
  lookUp,
  post,
  REASON_TEXT,
  saveProgress,
  statusOf,
  stopped,
  type Session,
  type VerifyOptions,
  type VerifySystem,
} from './verify-github-index';

export type { VerifyOptions };
// The part of the CLI context this command reads.
export interface VerifyContext {
  env: SellerOutput['env'];
  cwd?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: DiscoveryFetch;
  prompt?: Prompt;
  interrupt?: AbortSignal;
  verify?: VerifyOptions;
}

const USAGE =
  'Usage: gyblos seller verify github <user> [--gist <url|id>]\n       gyblos seller verify github --status\n       gyblos seller verify github --cancel\n';

function reportAnswer(
  session: Session,
  account: string,
  gist: string,
  answer: GithubClaimAnswer,
) {
  const url = gistWebUrl(account, gist);
  if (answer.state === GITHUB_CLAIM_STATES.VERIFIED) {
    session.output.stdout(
      `Verified: GitHub account ${account} is linked to seller ${session.nodeId}.\n  Anyone can check the proof at ${url}\n`,
    );
    return EXIT.ok;
  }
  const reason = answer.reason ?? GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE;
  const wait =
    answer.retryAfter !== undefined ? ` (in about ${answer.retryAfter} s)` : '';
  return fail(
    session.output,
    VERIFY_ERRORS.NOT_VERIFIED,
    `Not verified yet: ${REASON_TEXT[reason]}${wait}. Gist: ${url}`,
  );
}

// The gist is not on GitHub: it is never used again without --gist, and the seller is told what to do.
async function gistGone(session: Session, account: string, gist: ChosenGist) {
  if (
    !(await saveProgress(session, {
      account,
      gist: gist.id,
      step: VERIFY_STEPS.GIST_MISSING,
    }))
  )
    return EXIT.failure;
  const url = gistWebUrl(account, gist.id);
  return fail(
    session.output,
    VERIFY_ERRORS.GIST_NOT_FOUND,
    gist.source === GIST_SOURCES.GIVEN
      ? `GitHub shows no gist ${url} with a file named ${IDENTITY_CLAIM.proofFile}. Check the address, then run again with --gist <gist URL>`
      : `The gist ${url} with a file named ${IDENTITY_CLAIM.proofFile} is no longer on GitHub. Run the same command again to make a new one, or run again with --gist <new gist URL>`,
  );
}

// Already verified for this account: nothing to send.
async function alreadyVerified(
  session: Session,
  account: string,
  gist: string,
) {
  if (
    !(await saveProgress(session, {
      account,
      gist,
      step: VERIFY_STEPS.VERIFIED,
    }))
  )
    return EXIT.failure;
  session.output.stdout(
    `Already verified: GitHub account ${account} is linked to seller ${session.nodeId}.\n  Proof: ${gistWebUrl(account, gist)}\n`,
  );
  return EXIT.ok;
}

async function verify(
  session: Session,
  account: string,
  given: string | undefined,
) {
  const { output, environment, nodeId } = session;
  let view: GithubClaimView | null;
  try {
    view = await lookUp(session);
  } catch (error) {
    return indexFailure(session, error);
  }
  const saved = await readProgress(environment, nodeId);
  // A replacement gist saved for this account is still to be sent, even while the index shows the old
  // one verified.
  const replacement =
    saved?.account === account &&
    saved.step === VERIFY_STEPS.GIST &&
    saved.gist !== null &&
    saved.gist !== view?.gist;
  if (
    given === undefined &&
    !replacement &&
    view?.account === account &&
    view.state === GITHUB_CLAIM_STATES.VERIFIED
  )
    return alreadyVerified(session, account, view.gist);
  const gist = await gistFor(session, account, given, saved, view);
  if (typeof gist === 'number') return gist;
  if (session.system.interrupt?.aborted) return stopped(session);
  if (
    !(await saveProgress(session, {
      account,
      gist: gist.id,
      step: VERIFY_STEPS.GIST,
    }))
  )
    return EXIT.failure;
  const found = await checkGist(
    session.system.fetch,
    account,
    gist.id,
    nodeId,
    session.system.interrupt,
  );
  if (session.system.interrupt?.aborted) return stopped(session);
  const url = gistWebUrl(account, gist.id);
  // A gist made moments ago may not be served yet; the index checks it anyway.
  if (found === GIST_CHECKS.NOT_FOUND && gist.source !== GIST_SOURCES.CREATED)
    return gistGone(session, account, gist);
  if (found === GIST_CHECKS.WRONG_FILE)
    return fail(
      output,
      VERIFY_ERRORS.PROOF_FILE_MISSING,
      `The gist ${url} exists but has no file named ${IDENTITY_CLAIM.proofFile}. Rename its file to ${IDENTITY_CLAIM.proofFile}, then run the same command again`,
    );
  if (found === GIST_CHECKS.MISSING)
    return fail(
      output,
      VERIFY_ERRORS.PROOF_MISSING,
      `The gist ${url} does not contain the line\n  ${githubProofLine(nodeId)}\nAdd it on a line of its own, then run the same command again`,
    );
  output.stdout(
    `Asking ${urlOrigin(session.baseUrl)} to check ${url} for seller ${nodeId}...\n`,
  );
  let answer: GithubClaimAnswer;
  try {
    answer = await post(session, account, gist.id);
  } catch (error) {
    return indexFailure(session, error);
  }
  if (
    answer.state === GITHUB_CLAIM_STATES.VERIFIED &&
    !(await saveProgress(session, {
      account,
      gist: gist.id,
      step: VERIFY_STEPS.VERIFIED,
    }))
  )
    return EXIT.failure;
  return reportAnswer(session, account, gist.id, answer);
}

function parseVerify(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      options: {
        gist: { type: 'string' },
        status: { type: 'boolean' },
        cancel: { type: 'boolean' },
      },
      allowPositionals: true,
    });
  } catch {
    return undefined;
  }
}

// `args` follow `seller verify`.
export async function verifyCommand(
  args: readonly string[],
  context: VerifyContext,
) {
  const output: SellerOutput = {
    env: context.env,
    cwd: context.cwd ?? process.cwd(),
    stdout: context.stdout,
    stderr: context.stderr,
  };
  const system: VerifySystem = {
    ...context.verify,
    fetch: context.fetch ?? ((input, init) => fetch(input, init)),
    prompt: context.prompt,
    interrupt: context.interrupt,
  };
  const parsed = parseVerify(args);
  const [provider, user, ...rest] = parsed?.positionals ?? [];
  const { gist, status, cancel: cancelling } = parsed?.values ?? {};
  const modes = [status, cancelling, user !== undefined].filter(Boolean);
  if (
    !parsed ||
    provider !== 'github' ||
    rest.length ||
    modes.length !== 1 ||
    (gist !== undefined && user === undefined)
  ) {
    output.stderr(USAGE);
    return EXIT.failure;
  }
  const account = user?.trim().toLowerCase();
  if (account !== undefined && !validAccount(account))
    return fail(
      output,
      VERIFY_ERRORS.ACCOUNT_INVALID,
      'That is not a GitHub user name (letters, digits and single hyphens, at most 39 characters)',
    );
  const environment = homeEnvironmentOf(output);
  const identity = await sellerIdentity(environment, output);
  if (!identity) return EXIT.failure;
  const discovery = await discoverySettings(output, true);
  if (!discovery)
    return fail(
      output,
      VERIFY_ERRORS.CONFIG_INVALID,
      commandsFor(
        runMode(output.env),
        'The configuration is invalid. Run `gyblos doctor`',
      ),
    );
  const session: Session = {
    output,
    system,
    environment,
    nodeId: identity.nodeId,
    baseUrl: discovery.url,
    now: system.now ?? Date.now,
  };
  if (status) return statusOf(session);
  if (cancelling) return cancel(session);
  return verify(session, account ?? '', gist);
}
