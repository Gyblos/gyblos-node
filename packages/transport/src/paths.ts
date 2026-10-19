import type { Connection } from '@number0/iroh';

import type { TransportRoute } from './types.js';

export function selectedRoute(connection: Connection): TransportRoute {
  const paths = connection.paths().filter((path) => path.isSelected);
  if (paths.length !== 1) return 'unknown';
  const path = paths[0]!;
  if (path.isIp && !path.isRelay) return 'iroh-direct';
  if (path.isRelay && !path.isIp) return 'iroh-relay';
  return 'unknown';
}
