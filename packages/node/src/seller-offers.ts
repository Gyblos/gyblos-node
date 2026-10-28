// Prepares the seller's offer for advertisement: builds its engine through the registry at the offer's own
// URL and runs the private warmup. Starts no process and binds no port; the seller runs its engine.
import type { MemorySnapshot } from '@gyblos/runtime/memory';

import type { EngineDependencies } from './engine-factory';
import { prepareSellerEngine, type ReadinessRecord } from './engine-readiness';
import { createSellerEngine } from './engine-registry';
import type { SellerSettings } from './seller-settings';

export interface SellerOfferDependencies extends EngineDependencies {
  snapshot: () => Promise<MemorySnapshot>;
  record: (record: ReadinessRecord) => Promise<void>;
}

export async function prepareSellerOffers(
  settings: Pick<SellerSettings, 'engineOffer'>,
  dependencies: SellerOfferDependencies,
) {
  const { fetch, environment, snapshot, record } = dependencies;
  const prepared = createSellerEngine(settings.engineOffer, {
    fetch,
    environment,
  });
  const ready = await prepareSellerEngine(prepared.engine, {
    policy: prepared.readiness,
    snapshot,
    record,
  });
  return { prepared, ...ready };
}
