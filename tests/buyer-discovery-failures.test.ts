// Verifies resource ownership when durable discovery state fails during parallel control refresh.
// Deferred synthetic clients and loopback records only; no payment or operational state is used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import {
  selectBuyerQuote,
  type BuyerControlClient,
} from '@gyblos/buyer/selection';
import { BuyerSelectionError } from '@gyblos/buyer/selection-config';

import { discoveryRun } from './support/buyer-discovery';

void test('fatal replay persistence failure waits for pending connects and closes every client without quoting', async () => {
  const first = await discoveryRun();
  const second = await discoveryRun();
  let releaseSecond = () => {};
  const delayed = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let observedFirst = () => {};
  const failed = new Promise<void>((resolve) => {
    observedFirst = resolve;
  });
  let closed = 0;
  let offers = 0;
  function wrapped(client: BuyerControlClient): BuyerControlClient {
    return {
      getCatalog: client.getCatalog.bind(client),
      getPresence: client.getPresence.bind(client),
      async requestOffer() {
        offers++;
        throw new Error('No quote is allowed.');
      },
      async close() {
        closed++;
        await client.close();
      },
    };
  }
  let settled = false;
  const result = selectBuyerQuote(
    {
      ...first.config,
      sellers: [...first.config.sellers, ...second.config.sellers],
    },
    {
      ...first.dependencies,
      async connect(seller) {
        if (seller.nodeId === second.catalog.nodeId) {
          await delayed;
          return wrapped(second.client);
        }
        return wrapped(first.client);
      },
      async observeVerified() {
        observedFirst();
        throw new BuyerSelectionError(BUYER_SELECTION_CODES.DISCOVERY_STATE);
      },
    },
  ).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await failed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseSecond();
    const error = await result;
    assert.ok(error instanceof BuyerSelectionError);
    assert.equal(error.code, BUYER_SELECTION_CODES.DISCOVERY_STATE);
    assert.equal(closed, 2);
    assert.equal(offers, 0);
  } finally {
    releaseSecond();
    await result;
    await first.wire.close();
    await second.wire.close();
  }
});
