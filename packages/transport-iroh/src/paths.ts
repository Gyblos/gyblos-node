import type { Connection } from '@number0/iroh';

import { TRANSPORT_ROUTES } from './constants.js';
import type { TransportRoute } from './types.js';

export function selectedRoute(connection: Connection): TransportRoute {
  const paths = connection.paths().filter((path) => path.isSelected);
  if (paths.length !== 1) return TRANSPORT_ROUTES.UNKNOWN;
  const path = paths[0]!;
  if (path.isIp && !path.isRelay) return TRANSPORT_ROUTES.DIRECT;
  if (path.isRelay && !path.isIp) return TRANSPORT_ROUTES.RELAY;
  return TRANSPORT_ROUTES.UNKNOWN;
}
