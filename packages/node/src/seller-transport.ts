// Wires the seller's control and free services to isolated Iroh channels. The daemon binds no HTTP ALPN
// while paid selling is off, so the bridge's HTTP target is never dialed.
import type { Endpoint } from '@number0/iroh';

import { LOCALHOST, PORTS } from '@gyblos/config';
import type { ControlService } from '@gyblos/transport-iroh/control-server';
import type { FreeExecutionService } from '@gyblos/transport-iroh/free-server';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';
import type { ReceiptService } from '@gyblos/transport-iroh/receipt-service';

import type { SellerLimits } from './node-config-limits';

export function serveSellerTransport(
  endpoint: Endpoint,
  services: {
    control: ControlService;
    receipts?: ReceiptService;
    free: FreeExecutionService | undefined;
  },
  options: { relayOnly: boolean; limits: SellerLimits },
) {
  return serveIroh(
    endpoint,
    `http://${LOCALHOST}:${PORTS.seller}`,
    options.relayOnly,
    services.control,
    services.free,
    options.limits.transport,
    services.receipts,
  );
}
