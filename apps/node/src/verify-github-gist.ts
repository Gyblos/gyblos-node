// The gist step of `gyblos seller verify github`: which gist to use (--gist, the saved one, the index's, one
// made with the GitHub CLI or one the seller creates and pastes) and parsing what the seller types. Anything
// the GitHub CLI prints is validated before it is used or shown.
import type { GithubClaimView } from '@gyblos/discovery-http';
import { IDENTITY_CLAIM } from '@gyblos/protocol/identity-claim';

import {
  GIST_SOURCES,
  VERIFY_ERRORS,
  VERIFY_GITHUB,
  VERIFY_STEPS,
  type GistSource,
} from './constants';
import { githubCli } from './gist-tool';
import {
  gistDescription,
  gistWebUrl,
  parseGistReference,
  proofText,
  validAccount,
  validGist,
  type VerifyProgress,
} from './github-verification';
import type { SellerOutput } from './seller-home';
import { fail, type Session } from './verify-github-index';

export interface ChosenGist {
  id: string;
  source: GistSource;
}

function parseGist(
  output: SellerOutput,
  account: string,
  text: string,
  source: GistSource,
): ChosenGist | number {
  const reference = parseGistReference(text);
  if (!reference)
    return fail(
      output,
      VERIFY_ERRORS.GIST_INVALID,
      'That is not a gist address or id. Copy the address of your gist from gist.github.com',
    );
  if (reference.owner !== null && reference.owner !== account)
    return fail(
      output,
      VERIFY_ERRORS.GIST_OWNER,
      `That gist belongs to ${reference.owner}, not ${account}. Create the gist while signed in as ${account}`,
    );
  return { id: reference.id, source };
}

// A gist through the GitHub CLI when it is signed in as the account: the one an earlier, interrupted run
// made (found by its description) or a new one. Undefined when gh cannot be used.
async function gistByCli(
  session: Session,
  account: string,
): Promise<ChosenGist | number | undefined> {
  const { output } = session;
  const tool = session.system.gist ?? githubCli;
  const failed = () =>
    // gh's output and error text can carry local paths, server detail or control characters; only the
    // code is shown.
    fail(
      output,
      VERIFY_ERRORS.GH_FAILED,
      `The GitHub CLI could not create the gist. Create it yourself at ${VERIFY_GITHUB.gistWebOrigin}, then run \`gyblos seller verify github ${account} --gist <gist URL>\``,
    );
  const login = await tool.login();
  if (login !== undefined && !validAccount(login)) return failed();
  if (login !== undefined && login !== account)
    output.stdout(
      `The GitHub CLI is signed in as ${login}, not ${account}, so it is not used.\n`,
    );
  if (login !== account) return undefined;
  const description = gistDescription(session.nodeId);
  try {
    const existing = await tool.find(description);
    if (existing !== undefined) {
      if (!validGist(existing)) return failed();
      output.stdout(
        `Using your existing proof gist ${gistWebUrl(account, existing)}\n`,
      );
      return { id: existing, source: GIST_SOURCES.CREATED };
    }
    output.stdout(`Creating a gist as ${account} with the GitHub CLI...\n`);
    const reference = parseGistReference(
      await tool.create(proofText(session.nodeId), description),
    );
    if (!reference || (reference.owner !== null && reference.owner !== account))
      return failed();
    return { id: reference.id, source: GIST_SOURCES.CREATED };
  } catch {
    return failed();
  }
}

// The gist to use: --gist, the saved one, the index's for this account (unless the last run found it gone),
// one through gh, or one the seller creates and pastes. A number after printing why there is none.
export async function gistFor(
  session: Session,
  account: string,
  given: string | undefined,
  saved: VerifyProgress | undefined,
  view: GithubClaimView | null,
): Promise<ChosenGist | number> {
  const { output } = session;
  if (given !== undefined)
    return parseGist(output, account, given, GIST_SOURCES.GIVEN);
  const mine = saved?.account === account ? saved : undefined;
  const gone = mine?.step === VERIFY_STEPS.GIST_MISSING ? mine.gist : null;
  if (mine?.gist && !gone) return { id: mine.gist, source: GIST_SOURCES.SAVED };
  if (view?.account === account && view.gist !== gone)
    return { id: view.gist, source: GIST_SOURCES.INDEX };
  const byCli = await gistByCli(session, account);
  if (byCli) return byCli;
  output.stdout(
    `Create a gist at ${VERIFY_GITHUB.gistWebOrigin} while signed in as ${account}, with one file named ${IDENTITY_CLAIM.proofFile} holding this text:\n\n${proofText(session.nodeId)}\n`,
  );
  if (!session.system.prompt)
    return fail(
      output,
      VERIFY_ERRORS.NO_GIST,
      `Then run \`gyblos seller verify github ${account} --gist <gist URL>\``,
    );
  const answer = await session.system.prompt('Gist URL (after creating it): ');
  return parseGist(output, account, answer, GIST_SOURCES.GIVEN);
}
