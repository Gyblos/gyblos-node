// Owns the gist check behind a seller GitHub claim. The raw URL gist.githubusercontent.com/<account>/
// <gist>/raw answers 200 only when <account> owns the gist, so ownership needs no GitHub API or token.
// The account name is matched case-insensitively; claims carry it lowercase. No redirect is followed (a
// redirect is not found), the wait and the bytes read are bounded, and nothing is logged or echoed.
import { readGithubProof } from '@gyblos/protocol/identity-claim';

import {
  GITHUB_CLAIM,
  GITHUB_CLAIM_REASONS,
  type GithubClaimReason,
} from './constants';

export type GistFetch = (url: string, init: RequestInit) => Promise<Response>;
// Null when the proof was found.
export type GistOutcome = Exclude<
  GithubClaimReason,
  typeof GITHUB_CLAIM_REASONS.CHECK_DEFERRED
> | null;

const INCONCLUSIVE: ReadonlySet<number> = new Set(GITHUB_CLAIM.inconclusive);
const inconclusive = (status: number) =>
  INCONCLUSIVE.has(status) || status >= GITHUB_CLAIM.serverError;

// Null when the account's gist carries the NodeId's proof line on a line of its own (surrounding
// whitespace ignored); otherwise the static reason. Never throws.
export async function checkGist(
  fetcher: GistFetch,
  claim: { nodeId: string; account: string; gist: string },
): Promise<GistOutcome> {
  const url = `${GITHUB_CLAIM.gistOrigin}/${claim.account}/${claim.gist}/raw`;
  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_CLAIM.fetchTimeoutMs),
    });
    if (response.status !== GITHUB_CLAIM.found) {
      await response.body?.cancel().catch(() => undefined);
      return inconclusive(response.status)
        ? GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE
        : GITHUB_CLAIM_REASONS.GIST_NOT_FOUND;
    }
    return (await readGithubProof(response.body, claim.nodeId))
      ? null
      : GITHUB_CLAIM_REASONS.NODE_ID_MISSING;
  } catch {
    return GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE;
  }
}
