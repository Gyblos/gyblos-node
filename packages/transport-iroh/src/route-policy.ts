// Owns route policy in transport-iroh; it must not know wallets or inference engines.
import { TRANSPORT_ROUTES } from './constants.js';
import type { RouteObservation } from './types.js';

export function expectedIrohRoute(value: string | undefined) {
  if (!value) return undefined;
  if (value === TRANSPORT_ROUTES.DIRECT || value === TRANSPORT_ROUTES.RELAY)
    return value;
  throw new Error('Invalid expected route.');
}

export function routesMatchRequired(
  observations: readonly RouteObservation[],
  expected: ReturnType<typeof expectedIrohRoute>,
) {
  return (
    observations.length > 0 &&
    observations.every((observation) => {
      if (
        observation.transport !== TRANSPORT_ROUTES.DIRECT &&
        observation.transport !== TRANSPORT_ROUTES.RELAY
      )
        return false;
      if (!expected) return true;
      return (
        observation.transport === expected &&
        (expected === TRANSPORT_ROUTES.DIRECT
          ? observation.directObserved === true &&
            observation.relayObserved === false
          : observation.relayObserved === true &&
            observation.directObserved === false)
      );
    })
  );
}
