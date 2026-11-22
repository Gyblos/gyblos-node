// Owns the gist check behind a seller GitHub claim. The raw URL gist.githubusercontent.com/<account>/
// <gist>/raw answers 200 only when <account> owns the gist, so ownership needs no GitHub API or token.
// No redirect is followed, the wait and the bytes read are bounded, and nothing is logged or echoed.
import { githubProofLine } from '@gyblos/protocol/identity-claim';

import {
  GITHUB_CLAIM,
  GITHUB_CLAIM_REASONS,
  type GithubClaimReason,
} from './constants';

export type GistFetch = (url: string, init: RequestInit) => Promise<Response>;

const missing: ReadonlySet<number> = new Set(GITHUB_CLAIM.missing);

// At most `maxBytes` of the body. When it was cut, the last (possibly partial) line is dropped, so a
// cut can only hide a proof line, never make one.
async function readPrefix(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      cut = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
  }
  const text = new TextDecoder().decode(bytes);
  return cut ? text.slice(0, Math.max(0, text.lastIndexOf('\n'))) : text;
}

// Null when the account's gist carries the NodeId's proof line on a line of its own (surrounding
// whitespace ignored); otherwise the static reason. Never throws.
export async function checkGist(
  fetcher: GistFetch,
  claim: { nodeId: string; account: string; gist: string },
): Promise<GithubClaimReason | null> {
  const url = `${GITHUB_CLAIM.gistOrigin}/${claim.account}/${claim.gist}/raw`;
  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_CLAIM.fetchTimeoutMs),
    });
    if (response.status !== GITHUB_CLAIM.found) {
      await response.body?.cancel().catch(() => undefined);
      return missing.has(response.status)
        ? GITHUB_CLAIM_REASONS.GIST_NOT_FOUND
        : GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE;
    }
    const proof = githubProofLine(claim.nodeId);
    const text = await readPrefix(response, GITHUB_CLAIM.maxGistBytes);
    return text.split('\n').some((line) => line.trim() === proof)
      ? null
      : GITHUB_CLAIM_REASONS.NODE_ID_MISSING;
  } catch {
    return GITHUB_CLAIM_REASONS.GITHUB_UNAVAILABLE;
  }
}
