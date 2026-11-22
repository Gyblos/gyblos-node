// The `github` line of `gyblos seller status --online`: the GitHub account the discovery index links to this
// seller and the state of its last gist check. Sends only the public NodeId; what the index reports is its
// own check, re-checkable by anyone from the gist.
import { fetchGithubClaim, GITHUB_CLAIM_STATES } from '@gyblos/discovery-http';

import { STATUS } from './constants';
import { gistWebUrl } from './github-verification';
import type { StatusSystem } from './status-system';

export async function githubLine(
  system: Pick<StatusSystem, 'fetch'>,
  baseUrl: string,
  nodeId: string,
) {
  try {
    const view = await fetchGithubClaim({
      baseUrl,
      nodeId,
      fetch: system.fetch,
      timeoutMs: STATUS.indexTimeoutMs,
    });
    if (!view)
      return 'not linked (`gyblos seller verify github <user>` links an account)';
    if (view.state === GITHUB_CLAIM_STATES.VERIFIED)
      return `${view.account}, verified (${gistWebUrl(view.account, view.gist)})`;
    return `${view.account}, ${view.state}${view.reason ? ` (${view.reason})` : ''}; \`gyblos seller verify github --status\` explains`;
  } catch {
    return 'unavailable (index unreachable)';
  }
}
