// Routing settings reuse the shared parser; ordinary selection behavior remains compatible.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectBusyAwareBuyerQuote } from '@gyblos/buyer/selection-busy';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import { UnsentSellerBusyError } from '@gyblos/node/buyer-routing';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import { selectionFixture } from './support/buyer-selection';

void test('buyer config accepts the shared explicit routing settings and rejects unknown fields', async (t) => {
  const host = await selectionFixture();
  t.after(host.wire.close);
  const routing = parseBuyerRoutingPolicy({ allowPinnedFallback: true });
  assert.deepEqual(
    parseBuyerSelectionConfig({ ...host.config, routing }).routing,
    routing,
  );
  assert.throws(() =>
    parseBuyerSelectionConfig({
      ...host.config,
      routing: { ...routing, unexpected: true },
    }),
  );
});
void test('an explicitly requested pinned-busy result is identified before the prompt without changing ordinary selection', async (t) => {
  const host = await selectionFixture();
  t.after(host.wire.close);
  const config = { ...host.config, pinnedNodeId: host.catalog.nodeId };
  const dependencies = {
    ...host.dependencies,
    connect: async () => ({
      ...host.client,
      getCatalog: host.client.getCatalog.bind(host.client),
      getPresence: host.client.getPresence.bind(host.client),
      close: host.client.close.bind(host.client),
      requestOffer: async () => {
        throw new ControlError(CONTROL_CODES.BUSY);
      },
    }),
    onPinnedBusy: (nodeId: string): never => {
      throw new UnsentSellerBusyError(nodeId);
    },
  };
  await assert.rejects(
    selectBusyAwareBuyerQuote(config, dependencies, AbortSignal.timeout(3000)),
    { name: 'UnsentSellerBusyError', nodeId: host.catalog.nodeId },
  );
});
