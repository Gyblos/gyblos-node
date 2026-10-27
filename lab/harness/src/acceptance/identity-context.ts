// Owns synthetic identity acceptance bookkeeping; reports counters, never identities or private content.
import { openBuyerIdentityVerifier } from '@gyblos/node/identity-verifier';

import { acceptanceAssert, assertAcceptanceActive } from './errors.js';
import {
  createFreeBuyer,
  type FreeAcceptanceBuyer,
  type FreeBuyerIdentityOptions,
} from './free-buyer.js';
import type { FreeAcceptanceFault } from './free-constants.js';
import type { IdentityAcceptanceCase } from './identity-constants.js';
import type { AcceptanceRegistry } from './identity-registry.js';
import { pump } from './phases.js';
import type { AcceptanceSession } from './session.js';

export interface IdentityAcceptanceContext {
  run: AcceptanceSession;
  registry: AcceptanceRegistry;
  signal: AbortSignal;
  cases: IdentityAcceptanceCase[];
  answers: number;
  queryGenerations: number;
  queryEngineAttempts: number;
  onCase?: (value: IdentityAcceptanceCase) => void;
}
export function registrySubject(run: AcceptanceSession) {
  return {
    nodeId: run.host().wire.nodeId,
    owner: run.identity.owner.address,
    nodeSigner: run.host().wire.nodeSigner,
  };
}
export function completed(
  context: IdentityAcceptanceContext,
  value: IdentityAcceptanceCase,
) {
  assertAcceptanceActive(context.signal);
  context.cases.push(value);
  context.onCase?.(value);
  assertAcceptanceActive(context.signal);
}
export async function withIdentityBuyer(
  context: IdentityAcceptanceContext,
  action: (buyer: FreeAcceptanceBuyer) => Promise<void>,
  options: {
    manualTrust?: boolean;
    beforeExecute?: () => Promise<void>;
    fault?: FreeAcceptanceFault;
    sellers?: AcceptanceSession[];
  } = {},
) {
  assertAcceptanceActive(context.signal);
  const identity: FreeBuyerIdentityOptions = {
    rpcUrl: context.registry.url,
    manualTrust: options.manualTrust,
    beforeExecute: options.beforeExecute,
  };
  const buyer = await createFreeBuyer(
    context.run,
    options.sellers,
    options.fault,
    identity,
  );
  try {
    await action(buyer);
  } finally {
    context.queryGenerations += buyer.queryGenerations();
    context.queryEngineAttempts += buyer.queryEngineAttempts();
    await buyer.close();
  }
}
export async function acceptedAnswer(
  context: IdentityAcceptanceContext,
  buyer: FreeAcceptanceBuyer,
) {
  await buyer.answer();
  context.answers++;
  await pump(context.run, 1);
}
export async function refusedAnswer(
  context: IdentityAcceptanceContext,
  buyer: FreeAcceptanceBuyer,
) {
  const before = buyer.generations();
  const dials = buyer.dials.length;
  const response = await buyer.chat();
  acceptanceAssert(response.status >= 400);
  acceptanceAssert(
    response.noRetry === undefined || response.noRetry === 'false',
  );
  acceptanceAssert(
    buyer.generations() === before && buyer.dials.length === dials,
  );
}
export async function identityDecision(
  context: IdentityAcceptanceContext,
  manualTrust = false,
) {
  const subject = registrySubject(context.run);
  const verifier = await openBuyerIdentityVerifier(
    context.run.workspace.environment,
    context.registry.url,
  );
  return verifier.verify(
    { nodeId: subject.nodeId, owner: subject.owner, manualTrust },
    context.signal,
  );
}
