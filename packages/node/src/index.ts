// Owns the default seller composition behind the small node lifecycle API.
// Importing the library must not start engines, read wallets or open sockets.
import type { TelemetrySink } from '@gyblos/protocol/telemetry';

import { createNodeLifecycle } from './lifecycle';
import { startSeller } from './seller';

export function createNode(options: { telemetry?: TelemetrySink } = {}) {
  return createNodeLifecycle(() => startSeller(options));
}
