// Exercises registry trust faults through actual buyer HTTP and preserves durable binding barriers.
// Registry mutations affect synthetic in-memory accounts only, never a blockchain.
import { generateKeyPairSigner } from '@solana/kit';

import { SELLER_READINESS } from '@gyblos/config';
import { OFFER_LIFETIME_MS } from '@gyblos/core/constants';
import {
  IDENTITY_POLICY_CODES,
  IDENTITY_TRUST_SOURCES,
} from '@gyblos/core/identity-policy';

import { ACCEPTANCE } from './constants.js';
import { acceptanceAssert } from './errors.js';
import {
  IDENTITY_ACCEPTANCE,
  IDENTITY_ACCEPTANCE_CASES,
} from './identity-constants.js';
import {
  acceptedAnswer,
  completed,
  identityDecision,
  refusedAnswer,
  registrySubject,
  withIdentityBuyer,
  type IdentityAcceptanceContext,
} from './identity-context.js';
import { identityStreamAnswer } from './identity-http.js';
import { pump, rejectReplay } from './phases.js';

export async function positiveIdentityPhases(
  context: IdentityAcceptanceContext,
) {
  await withIdentityBuyer(context, async (buyer) => {
    await acceptedAnswer(context, buyer);
    completed(context, IDENTITY_ACCEPTANCE_CASES.REGISTRY_ANSWER);
    await pump(context.run, 1);
    await identityStreamAnswer(context, buyer);
    completed(context, IDENTITY_ACCEPTANCE_CASES.REGISTRY_STREAM);
    await pump(context.run, 1);
    for (let cycle = 0; cycle < ACCEPTANCE.renewalCycles; cycle++) {
      await pump(
        context.run,
        OFFER_LIFETIME_MS - SELLER_READINESS.renewBeforeMs,
      );
      await acceptedAnswer(context, buyer);
    }
    completed(context, IDENTITY_ACCEPTANCE_CASES.REGISTRY_RENEWALS);
  });
}
export async function providerIdentityPhases(
  context: IdentityAcceptanceContext,
) {
  context.registry.available(false);
  try {
    await withIdentityBuyer(context, (buyer) => refusedAnswer(context, buyer));
    const state = await identityDecision(context);
    acceptanceAssert(
      !state.ok &&
        state.code === IDENTITY_POLICY_CODES.UNAVAILABLE &&
        state.state?.revoked === false,
    );
    completed(context, IDENTITY_ACCEPTANCE_CASES.RPC_OUTAGE);
  } finally {
    context.registry.available(true);
  }
  context.registry.oversized(true);
  try {
    await withIdentityBuyer(context, (buyer) => refusedAnswer(context, buyer));
    const state = await identityDecision(context);
    acceptanceAssert(
      !state.ok &&
        state.code === IDENTITY_POLICY_CODES.LIMIT &&
        state.state?.revoked === false &&
        state.state.binding.sequence === IDENTITY_ACCEPTANCE.initialSequence,
    );
    completed(context, IDENTITY_ACCEPTANCE_CASES.RPC_LIMIT);
  } finally {
    context.registry.oversized(false);
  }
}
export async function revokedIdentityPhases(
  context: IdentityAcceptanceContext,
) {
  let intercepted = 0;
  await withIdentityBuyer(context, (buyer) => refusedAnswer(context, buyer), {
    beforeExecute: async () => {
      intercepted++;
      context.registry.revoke(context.run.host().wire.nodeId);
    },
  });
  acceptanceAssert(intercepted === 1);
  const revoked = await identityDecision(context);
  acceptanceAssert(
    !revoked.ok &&
      revoked.code === IDENTITY_POLICY_CODES.REVOKED &&
      revoked.state?.revoked === true,
  );
  completed(context, IDENTITY_ACCEPTANCE_CASES.REVOCATION_AT_SEND);
  await withIdentityBuyer(
    context,
    async (buyer) => {
      const before = context.registry.counts().reads;
      const manual = await (
        await import('@gyblos/node/identity-verifier')
      ).openBuyerIdentityVerifier(
        context.run.workspace.environment,
        context.registry.url,
      );
      const result = await manual.verify(
        { ...registrySubject(context.run), manualTrust: true },
        context.signal,
      );
      acceptanceAssert(
        result.ok &&
          result.source === IDENTITY_TRUST_SOURCES.MANUAL &&
          result.state?.revoked === true,
      );
      await acceptedAnswer(context, buyer);
      acceptanceAssert(context.registry.counts().reads === before);
    },
    { manualTrust: true },
  );
  completed(context, IDENTITY_ACCEPTANCE_CASES.MANUAL_OVERRIDE);
  await withIdentityBuyer(context, (buyer) => refusedAnswer(context, buyer));
  const removed = await identityDecision(context);
  acceptanceAssert(
    !removed.ok &&
      removed.code === IDENTITY_POLICY_CODES.REVOKED &&
      removed.state?.revoked === true,
  );
  completed(context, IDENTITY_ACCEPTANCE_CASES.OVERRIDE_REMOVAL);
  await context.registry.bind(
    registrySubject(context.run),
    IDENTITY_ACCEPTANCE.initialSequence,
  );
  await withIdentityBuyer(context, (buyer) => refusedAnswer(context, buyer));
  const retained = await identityDecision(context);
  acceptanceAssert(
    !retained.ok &&
      retained.code === IDENTITY_POLICY_CODES.REVOKED &&
      retained.state?.binding.sequence === IDENTITY_ACCEPTANCE.initialSequence,
  );
  completed(context, IDENTITY_ACCEPTANCE_CASES.REVOCATION_RESTART);
}
export async function rotatedIdentityPhases(
  context: IdentityAcceptanceContext,
) {
  const nextOwner = await generateKeyPairSigner();
  const sequence = IDENTITY_ACCEPTANCE.initialSequence + 1n;
  await context.registry.bind(
    { ...registrySubject(context.run), owner: nextOwner.address },
    sequence,
  );
  await withIdentityBuyer(context, (buyer) => refusedAnswer(context, buyer));
  const changed = await identityDecision(context);
  acceptanceAssert(
    !changed.ok &&
      changed.code === IDENTITY_POLICY_CODES.OWNER_MISMATCH &&
      changed.state?.binding.owner === nextOwner.address &&
      changed.state.binding.sequence === sequence,
  );
  completed(context, IDENTITY_ACCEPTANCE_CASES.ROTATION_DENIAL);
  context.registry.rollback(
    context.run.host().wire.nodeId,
    IDENTITY_ACCEPTANCE.initialSequence,
  );
  await withIdentityBuyer(context, (buyer) => refusedAnswer(context, buyer));
  const stale = await identityDecision(context);
  acceptanceAssert(
    !stale.ok &&
      stale.code === IDENTITY_POLICY_CODES.STALE &&
      stale.state?.binding.sequence === sequence,
  );
  completed(context, IDENTITY_ACCEPTANCE_CASES.ROLLBACK_RESTART);
  const prior = context.run.host().control.records.current();
  const catalogSequence = prior.record.sequence;
  await context.registry.bind(
    { ...registrySubject(context.run), owner: nextOwner.address },
    sequence + 1n,
  );
  context.run.identity.owner = nextOwner;
  await context.run.restart();
  await context.run.clock.advance(1);
  acceptanceAssert(await context.run.host().publisher.tick());
  acceptanceAssert(
    context.run.host().control.records.current().record.sequence >
      catalogSequence,
  );
  await rejectReplay(context.run, prior);
  await withIdentityBuyer(context, (buyer) => acceptedAnswer(context, buyer));
  const accepted = await identityDecision(context);
  acceptanceAssert(
    accepted.ok &&
      accepted.source === IDENTITY_TRUST_SOURCES.REGISTRY &&
      accepted.state?.binding.sequence === sequence + 1n,
  );
  completed(context, IDENTITY_ACCEPTANCE_CASES.ROTATION_RECOVERY);
}
