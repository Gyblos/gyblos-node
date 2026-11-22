// `gyblos seller verify github <user> [--gist <url|id>]`, `--status` and `--cancel`: links this seller to a
// GitHub account. A public gist owned by the account holds the NodeId's proof line, and the node key signs a
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
import { githubProofLine } from '@gyblos/protocol/identity-claim';

import { urlOrigin } from './cli-format';
import type { Prompt } from './cli-init';
import { commandsFor } from './cli-next';
import { EXIT, VERIFY_ERRORS, VERIFY_GITHUB, VERIFY_STEPS } from './constants';
import { githubCli } from './gist-tool';
import {
  checkGist,
  GIST_CHECKS,
  gistWebUrl,
  parseGistReference,
  proofText,
  readProgress,
  validAccount,
  writeProgress,
  type VerifyProgress,
} from './github-verification';
import {
  discoverySettings,
  homeEnvironmentOf,
  sellerIdentity,
  type SellerOutput,
} from './seller-home';
import {
  cancel,
  fail,
  indexFailure,
  lookUp,
  post,
  REASON_TEXT,
  statusOf,
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
  verify?: VerifyOptions;
}

const USAGE =
  'Usage: gyblos seller verify github <user> [--gist <url|id>]\n       gyblos seller verify github --status\n       gyblos seller verify github --cancel\n';

// The gist to use: --gist, the saved one, the index's for this account, a new one through gh, or one the
// seller creates and pastes. Undefined after printing why there is none.
async function gistFor(
  session: Session,
  account: string,
  given: string | undefined,
  saved: VerifyProgress | undefined,
  view: GithubClaimView | null,
): Promise<{ id: string; created: boolean } | number> {
  const { output } = session;
  const parse = (text: string) => {
    const reference = parseGistReference(text);
    if (!reference)
      return fail(
        output,
        VERIFY_ERRORS.GIST_INVALID,
        'that is not a gist URL or id; copy the address of your gist from gist.github.com',
      );
    if (reference.owner !== null && reference.owner !== account)
      return fail(
        output,
        VERIFY_ERRORS.GIST_OWNER,
        `that gist belongs to ${reference.owner}, not ${account}; create the gist while signed in as ${account}`,
      );
    return { id: reference.id, created: false };
  };
  if (given !== undefined) return parse(given);
  if (saved?.account === account && saved.gist)
    return { id: saved.gist, created: false };
  if (view?.account === account) return { id: view.gist, created: false };
  const text = proofText(session.nodeId);
  const tool = session.system.gist ?? githubCli;
  const login = await tool.login();
  if (login !== undefined && login !== account)
    output.stdout(
      `The GitHub CLI is signed in as ${login}, not ${account}, so it is not used.\n`,
    );
  if (login === account) {
    output.stdout(
      `Creating a public gist as ${account} with the GitHub CLI...\n`,
    );
    const created = parse(await tool.create(text));
    return typeof created === 'number'
      ? created
      : { ...created, created: true };
  }
  output.stdout(
    `Create a PUBLIC gist at ${VERIFY_GITHUB.gistWebOrigin} while signed in as ${account}, with this text:\n\n${text}\n`,
  );
  if (!session.system.prompt)
    return fail(
      output,
      VERIFY_ERRORS.NO_GIST,
      `then run \`gyblos seller verify github ${account} --gist <gist URL>\``,
    );
  const answer = await session.system.prompt('Gist URL (after creating it): ');
  return parse(answer);
}

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
    `${answer.state ?? 'not stored'}: ${REASON_TEXT[reason]}${wait}. Gist: ${url}`,
  );
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
  if (
    given === undefined &&
    view?.account === account &&
    view.state === GITHUB_CLAIM_STATES.VERIFIED
  ) {
    await writeProgress(environment, {
      nodeId,
      account,
      gist: view.gist,
      step: VERIFY_STEPS.VERIFIED,
    });
    output.stdout(
      `Already verified: GitHub account ${account} is linked to seller ${nodeId}.\n  Proof: ${gistWebUrl(account, view.gist)}\n`,
    );
    return EXIT.ok;
  }
  const saved = await readProgress(environment, nodeId);
  const gist = await gistFor(session, account, given, saved, view);
  if (typeof gist === 'number') return gist;
  await writeProgress(environment, {
    nodeId,
    account,
    gist: gist.id,
    step: VERIFY_STEPS.GIST,
  });
  const found = await checkGist(session.system.fetch, account, gist.id, nodeId);
  const url = gistWebUrl(account, gist.id);
  if (found === GIST_CHECKS.NOT_FOUND && !gist.created)
    return fail(
      output,
      VERIFY_ERRORS.GIST_NOT_FOUND,
      `GitHub shows no public gist ${url}; check the account and that the gist is public, then run this again (or pass --gist)`,
    );
  if (found === GIST_CHECKS.MISSING)
    return fail(
      output,
      VERIFY_ERRORS.PROOF_MISSING,
      `the gist ${url} does not contain the line\n  ${githubProofLine(nodeId)}\nAdd it on a line of its own, then run this again`,
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
  await writeProgress(environment, {
    nodeId,
    account,
    gist: gist.id,
    step:
      answer.state === GITHUB_CLAIM_STATES.VERIFIED
        ? VERIFY_STEPS.VERIFIED
        : VERIFY_STEPS.POSTED,
  });
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
      'that is not a GitHub user name (letters, digits and single hyphens, at most 39 characters)',
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
        'configuration invalid; run `gyblos doctor`',
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
