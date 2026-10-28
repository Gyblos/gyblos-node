// Runs the actual index handler in process with memory storage and one explicit ephemeral publisher.
// Its injected fetch cannot reach a network origin, including the deployed discovery index.
import type { DiscoveryFetch } from '@gyblos/discovery-http';
import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { PUBLISH_MODES } from '@gyblos/discovery-index/constants';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';

import { ACCEPTANCE, ACCEPTANCE_CODES } from './constants';
import { AcceptanceError } from './errors';

export function createAcceptanceIndex(now: () => number, nodeId: string) {
  const storage = createMemoryStorage();
  const nodeIds = new Set([nodeId]);
  const app = createDiscoveryIndex({
    storage,
    now,
    development: true,
    publishers: { mode: PUBLISH_MODES.ALLOWLIST, nodeIds },
  });
  const fetch: DiscoveryFetch = async (input, init) => {
    const url = new URL(input);
    if (
      url.origin !== ACCEPTANCE.origin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith('/v1/')
    )
      throw new AcceptanceError(ACCEPTANCE_CODES.EXTERNAL_IO);
    init.signal?.throwIfAborted();
    return app.request(new Request(input, init));
  };
  return {
    baseUrl: ACCEPTANCE.baseUrl,
    fetch,
    storage,
    allowPublisher: (value: string) => nodeIds.add(value),
  };
}
export type AcceptanceIndex = ReturnType<typeof createAcceptanceIndex>;
