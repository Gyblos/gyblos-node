// Serves control, receipts, free inference and reusable payment channels on Iroh.
import type { Endpoint } from '@number0/iroh';

import { LOCALHOST, PORTS } from '@gyblos/config';
import type { BatchChannelService } from '@gyblos/transport-iroh/batch-server';
import type { ControlService } from '@gyblos/transport-iroh/control-server';
import type { FreeExecutionService } from '@gyblos/transport-iroh/free-server';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';
import type { ReceiptService } from '@gyblos/transport-iroh/receipt-service';

import type { SellerLimits } from './node-config-limits';

export function serveSellerTransport(
  endpoint: Endpoint,
  services: {
    control?: ControlService;
    receipts?: ReceiptService;
    free: FreeExecutionService | undefined;
    batchSessions?: BatchChannelService;
  },
  options: {
    relayOnly: boolean;
    limits: Pick<SellerLimits, 'transport' | 'maxFreeBuyers'>;
  },
) {
  return serveIroh(
    endpoint,
    `http://${LOCALHOST}:${PORTS.seller}`,
    options.relayOnly,
    services.control,
    services.free,
    options.limits.transport,
    services.receipts,
    services.batchSessions,
  );
}
