// Checks renewal/fault/restart phases over the product components, with explicit assertions and bounded time.
// Failure and busy controls are injected even with a real engine; they do not claim physical crash recovery.
import { SELLER_DISCOVERY, SELLER_READINESS } from '@gyblos/config';
import { OFFER_LIFETIME_MS, SELLER_BADGES } from '@gyblos/core/constants';
import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  publishRecord,
} from '@gyblos/discovery-http';
import { READINESS_GENERATION } from '@gyblos/engine-ollama/constants';
import { CONTROL_CODES, PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';

import { acceptQuote, listed, refuseCatalog } from './buyer.js';
import { ACCEPTANCE } from './constants.js';
import { acceptanceAssert, assertAcceptanceActive } from './errors.js';
import type { AcceptanceSession } from './session.js';

export async function pump(run: AcceptanceSession, milliseconds: number) {
  let remaining = milliseconds;
  while (remaining > 0) {
    const step = Math.min(SELLER_DISCOVERY.tickMs, remaining);
    await run.clock.advance(step);
    await run.host().observation.tick();
    const state = run.host().observation.readiness();
    if (!state.busy && state.validUntil > run.clock.now())
      await run.host().control.records.refresh();
    await run.host().publisher.tick();
    remaining -= step;
  }
}
export async function renewalCycles(run: AcceptanceSession) {
  let deadline = run.host().observation.readiness().validUntil;
  for (let index = 0; index < ACCEPTANCE.renewalCycles; index++) {
    await pump(run, OFFER_LIFETIME_MS - SELLER_READINESS.renewBeforeMs);
    const next = run.host().observation.readiness().validUntil;
    acceptanceAssert(next > deadline);
    deadline = next;
    await acceptQuote(run);
  }
}
export async function busyRecovery(run: AcceptanceSession) {
  const before = run.host().control.records.current().record.sequence;
  const release = run.engine.holdNext();
  const generation = run.host().observation.engine.generate({
    prompt: READINESS_GENERATION.prompt,
    maxTokens: READINESS_GENERATION.maxTokens,
    signal: run.signal,
  });
  // Observe rejection immediately if cancellation happens while the injected busy operation is held.
  void generation.catch(() => {});
  try {
    acceptanceAssert(run.host().observation.readiness().busy);
    acceptanceAssert(!(await run.host().observation.tick()));
    await refuseCatalog(run, CONTROL_CODES.BUSY);
    await run.host().publisher.tick();
    acceptanceAssert((await listed(run)).sellers.length === 0);
  } finally {
    release();
    await generation;
  }
  acceptanceAssert(await run.host().publisher.tick());
  acceptanceAssert(
    run.host().control.records.current().record.sequence > before,
  );
  await acceptQuote(run);
}
export async function failureRecovery(run: AcceptanceSession) {
  run.engine.fail(true);
  await pump(run, OFFER_LIFETIME_MS - SELLER_READINESS.renewBeforeMs);
  acceptanceAssert(
    run.host().observation.readiness().validUntil <= run.clock.now(),
  );
  await refuseCatalog(run, CONTROL_CODES.STALE);
  acceptanceAssert((await listed(run)).sellers.length === 0);
  run.engine.fail(false);
  await pump(run, SELLER_DISCOVERY.maxRetryMs);
  acceptanceAssert(
    run.host().observation.readiness().validUntil > run.clock.now(),
  );
  await acceptQuote(run);
}
export async function expiryRecovery(run: AcceptanceSession) {
  // Deliberately suspend checks/publication through the boundary; this is a stale-observation test.
  await run.clock.advance(
    run.host().observation.readiness().validUntil - run.clock.now(),
  );
  await refuseCatalog(run, CONTROL_CODES.EXPIRED);
  acceptanceAssert(!(await run.host().publisher.tick()));
  acceptanceAssert((await listed(run)).sellers.length === 0);
  await pump(run, SELLER_DISCOVERY.maxRetryMs);
  await acceptQuote(run);
}
export async function rejectReplay(
  run: AcceptanceSession,
  record: SignedPublicV2,
) {
  // Still temporally valid: this must demonstrate replay/tombstone handling, not expiry.
  acceptanceAssert(record.record.expiresAt > run.clock.now());
  let stale = false;
  try {
    await publishRecord({
      baseUrl: run.index.baseUrl,
      record,
      fetch: run.index.fetch,
      signal: run.signal,
    });
  } catch (error) {
    stale =
      error instanceof DiscoveryError &&
      error.code === DISCOVERY_ERROR_CODES.STALE_RECORD;
  }
  acceptanceAssert(stale);
}
export async function withdrawAndRestart(run: AcceptanceSession) {
  const host = run.host();
  const old = host.control.records.current();
  acceptanceAssert(old.record.kind === PUBLIC_RECORD_KINDS.CATALOG);
  const oldDigest = await catalogDigestV2(old.record);
  const prior = (await listed(run)).sellers[0];
  acceptanceAssert(prior);
  await host.publisher.stop();
  const withdrawn = host.sent.at(-1);
  acceptanceAssert(withdrawn?.record.kind === PUBLIC_RECORD_KINDS.WITHDRAWAL);
  acceptanceAssert((await listed(run)).sellers.length === 0);
  await rejectReplay(run, old);
  await run.restart();
  // Check the reopened high-water mark before fresh discovery/quotes could repair a lost store.
  acceptanceAssert(
    !(await run.state().observe({
      catalog: prior.catalog,
      presence: prior.presence,
      withdrawal: null,
      badge: SELLER_BADGES.DECLARED_USAGE,
      openChannel: false,
    })),
  );
  acceptanceAssert(run.host().wire.nodeId === old.record.nodeId);
  acceptanceAssert(
    run.host().control.records.current().record.sequence >
      withdrawn.record.sequence,
  );
  acceptanceAssert(await run.host().publisher.tick());
  const fresh = await acceptQuote(run);
  acceptanceAssert(fresh.quote.offer.catalogDigest !== oldDigest);
  acceptanceAssert(
    !(await run
      .state()
      .permits(
        run.identity.owner.address,
        old.record.nodeId,
        oldDigest,
        run.clock.now(),
      )),
  );
  assertAcceptanceActive(run.signal);
}
