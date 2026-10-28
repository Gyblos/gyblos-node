// Prepares the seller's offers for advertisement: builds each engine through the registry at the offer's
// own URL and runs its private warmup, one offer at a time so warmups never compete for memory. Startup
// needs one ready offer; the others are warmed again in the background until they are ready or the seller
// stops. Starts no process and binds no port; the seller runs its engines.
import { SELLER_READINESS } from '@gyblos/config';
import type { MemorySnapshot } from '@gyblos/runtime/memory';

import { checkedControlOffer } from './control-offers';
import { observeControlReadiness } from './control-readiness';
import type { EngineDependencies, PreparedEngine } from './engine-factory';
import {
  prepareSellerEngine,
  probeSellerEngine,
  type ReadinessRecord,
} from './engine-readiness';
import { createSellerEngine } from './engine-registry';
import type { LiveSellerOffer } from './seller-offer-set';
import type { SellerOfferSettings, SellerSettings } from './seller-settings';

export interface SellerOfferDependencies extends EngineDependencies {
  snapshot: () => Promise<MemorySnapshot>;
  // Each warmup's private outcome, by gyblos.toml [[offers]] index.
  record: (index: number, record: ReadinessRecord) => Promise<void>;
  // The engine registry unless a test supplies its own plugins.
  create?: typeof createSellerEngine;
  now?: () => number;
}

export interface PendingSellerOffer {
  settings: SellerOfferSettings;
  prepared: PreparedEngine;
}
export interface WarmedSellerOffer extends PendingSellerOffer {
  model: Awaited<ReturnType<typeof prepareSellerEngine>>['model'];
  offerExpiresAt: number;
}

async function warm(
  offer: PendingSellerOffer,
  dependencies: SellerOfferDependencies,
  signal?: AbortSignal,
): Promise<WarmedSellerOffer> {
  const { index } = offer.settings.engine;
  const ready = await prepareSellerEngine(offer.prepared.engine, {
    policy: offer.prepared.readiness,
    snapshot: dependencies.snapshot,
    record: (record) => dependencies.record(index, record),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(signal ? { signal } : {}),
  });
  return { ...offer, ...ready };
}

// Throws the first offer's failure when no offer is ready.
export async function prepareSellerOffers(
  settings: Pick<SellerSettings, 'offers'>,
  dependencies: SellerOfferDependencies,
) {
  const create = dependencies.create ?? createSellerEngine;
  const ready: WarmedSellerOffer[] = [];
  const pending: PendingSellerOffer[] = [];
  let failure: unknown;
  for (const offer of settings.offers) {
    const prepared = create(offer.engine, {
      fetch: dependencies.fetch,
      environment: dependencies.environment,
    });
    try {
      ready.push(await warm({ settings: offer, prepared }, dependencies));
    } catch (error) {
      failure ??= error;
      pending.push({ settings: offer, prepared });
    }
  }
  if (!ready.length) throw failure;
  return { ready, pending };
}

// The warmed offer as the seller serves it: its readiness renews in the background once started.
export async function liveSellerOffer(
  warmed: WarmedSellerOffer,
  dependencies: Pick<SellerOfferDependencies, 'snapshot' | 'now'>,
): Promise<LiveSellerOffer> {
  const { prepared, settings } = warmed;
  const observation = observeControlReadiness(
    prepared.engine,
    warmed.offerExpiresAt,
    dependencies.now ?? Date.now,
    {
      model: warmed.model,
      check: (signal) =>
        probeSellerEngine(prepared.engine, signal, {
          policy: prepared.readiness,
          snapshot: dependencies.snapshot,
        }),
    },
  );
  const live: LiveSellerOffer = {
    index: settings.engine.index,
    selection: prepared.selection,
    offer: settings.offer,
    model: warmed.model,
    capabilities: prepared.engine.capabilities(),
    meteringMode: prepared.metering.mode,
    readiness: observation.readiness,
    engine: observation.engine,
    tokenizer: await prepared.metering.tokenizer(),
    observation,
  };
  checkedControlOffer(live);
  return live;
}

// Warms the offers that were not ready at startup again, one at a time, every retryMs; each that becomes
// ready is handed to add. stop() aborts a warmup in progress and settles once it has.
export function retrySellerOffers(
  pending: readonly PendingSellerOffer[],
  dependencies: SellerOfferDependencies & {
    add: (offer: LiveSellerOffer) => Promise<void>;
    retryMs?: number;
  },
) {
  const waiting = [...pending];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  const attempt = async () => {
    for (const offer of [...waiting]) {
      if (controller.signal.aborted) return;
      try {
        const warmed = await warm(offer, dependencies, controller.signal);
        if (controller.signal.aborted) return;
        await dependencies.add(await liveSellerOffer(warmed, dependencies));
        waiting.splice(waiting.indexOf(offer), 1);
      } catch {
        // Still pending; its readiness record says why.
      }
    }
  };
  const schedule = () => {
    if (controller.signal.aborted || !waiting.length) return;
    timer = setTimeout(() => {
      running = attempt().finally(schedule);
    }, dependencies.retryMs ?? SELLER_READINESS.retryMs);
  };
  schedule();
  return {
    pending: () => waiting.map((offer) => offer.settings.engine.index),
    async stop() {
      controller.abort();
      clearTimeout(timer);
      await running;
    },
  };
}
