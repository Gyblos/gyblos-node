// Runs the full free path with independent signed synthetic 8004 accounts and durable buyer state.
// The only external boundary is ephemeral loopback HTTP/Iroh; operational inputs are not accepted.
import { HTTP_STATUS, SELLER_DISCOVERY } from '@gyblos/config';

import { ACCEPTANCE_INDEX } from './constants.js';
import { acceptanceAssert, assertAcceptanceActive } from './errors.js';
import { FREE_ACCEPTANCE_FAULTS } from './free-constants.js';
import { createFreeSeller } from './free-session.js';
import {
  IDENTITY_ACCEPTANCE,
  IDENTITY_ACCEPTANCE_CASES,
  type IdentityAcceptanceCase,
} from './identity-constants.js';
import {
  completed,
  registrySubject,
  withIdentityBuyer,
  type IdentityAcceptanceContext,
} from './identity-context.js';
import { identityStreamCancellation } from './identity-http.js';
import {
  positiveIdentityPhases,
  providerIdentityPhases,
  revokedIdentityPhases,
  rotatedIdentityPhases,
} from './identity-phases.js';
import {
  createAcceptanceRegistry,
  type AcceptanceRegistry,
} from './identity-registry.js';
import { pump } from './phases.js';
import type { AcceptanceSession } from './session.js';

export interface IdentityAcceptanceOptions {
  signal?: AbortSignal;
  onCase?: (value: IdentityAcceptanceCase) => void;
}
async function noPostSendRetry(context: IdentityAcceptanceContext) {
  const alternate = await createFreeSeller(context.signal, context.run);
  try {
    await context.registry.bind(
      registrySubject(alternate),
      IDENTITY_ACCEPTANCE.initialSequence,
    );
    acceptanceAssert(await alternate.host().publisher.tick());
    await withIdentityBuyer(
      context,
      async (buyer) => {
        const before = buyer.generations();
        const response = await buyer.chat();
        acceptanceAssert(
          response.status >= HTTP_STATUS.badRequest &&
            response.noRetry === 'false',
        );
        acceptanceAssert(
          buyer.dials.length === 1 &&
            buyer.selections() === 1 &&
            buyer.generations() === before + 1,
        );
      },
      {
        fault: FREE_ACCEPTANCE_FAULTS.RESPONSE,
        sellers: [context.run, alternate],
      },
    );
  } finally {
    await alternate.close();
  }
}
export async function runIdentityAcceptance(
  options: IdentityAcceptanceOptions = {},
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(IDENTITY_ACCEPTANCE.maxRunMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  assertAcceptanceActive(signal);
  let run: AcceptanceSession | undefined;
  let registry: AcceptanceRegistry | undefined;
  try {
    run = await createFreeSeller(signal);
    registry = await createAcceptanceRegistry(signal);
    await registry.bind(
      registrySubject(run),
      IDENTITY_ACCEPTANCE.initialSequence,
    );
    acceptanceAssert(await run.host().publisher.tick());
    const context: IdentityAcceptanceContext = {
      run,
      registry,
      signal,
      cases: [],
      answers: 0,
      queryGenerations: 0,
      queryEngineAttempts: 0,
      onCase: options.onCase,
    };
    await positiveIdentityPhases(context);
    await providerIdentityPhases(context);
    await revokedIdentityPhases(context);
    await rotatedIdentityPhases(context);
    await withIdentityBuyer(context, (buyer) =>
      identityStreamCancellation(context, buyer),
    );
    completed(context, IDENTITY_ACCEPTANCE_CASES.STREAM_CANCELLATION);
    await pump(run, SELLER_DISCOVERY.maxRetryMs);
    await noPostSendRetry(context);
    completed(context, IDENTITY_ACCEPTANCE_CASES.NO_POST_SEND_RETRY);
    acceptanceAssert(
      context.queryGenerations === 0 && context.queryEngineAttempts === 0,
    );
    completed(context, IDENTITY_ACCEPTANCE_CASES.NO_QUERY_INFERENCE);
    acceptanceAssert(
      registry.counts().reads > 0 && registry.counts().forbidden === 0,
    );
    completed(context, IDENTITY_ACCEPTANCE_CASES.NO_PAID_SERVICES);
    return {
      ok: true,
      identityEnabled: true,
      registry: IDENTITY_ACCEPTANCE.registry,
      index: ACCEPTANCE_INDEX,
      nativeIroh: true,
      paymentsEnabled: false,
      answers: context.answers,
      registryReads: registry.counts().reads,
      forbiddenRpcMethods: registry.counts().forbidden,
      queryGenerations: context.queryGenerations,
      queryEngineAttempts: context.queryEngineAttempts,
      noPostSendRetry: true,
      cases: context.cases,
    };
  } catch (error) {
    assertAcceptanceActive(signal);
    throw error;
  } finally {
    try {
      await registry?.close();
    } finally {
      await run?.close();
    }
  }
}
