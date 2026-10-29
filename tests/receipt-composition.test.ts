// Receipt observations must survive production per-offer routing with the engine kind belonging to each offer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FreeSellerLedger } from '@gyblos/core/free-admission';
import type { FreeSellerReceiptInput } from '@gyblos/core/receipts';
import { createSellerFreeOffers } from '@gyblos/node/free-offers';
import { ENGINE_KINDS, FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { buildFreeExecutionRequest } from '@gyblos/protocol/free-execution';

import {
  BUYER_NODE,
  offerControlFixture,
} from './support/seller-offer-control';

void test('production offer composition forwards receipt publisher and exact per-offer engine kinds', async () => {
  const f = await offerControlFixture();
  const observations: FreeSellerReceiptInput[] = [];
  const offers = [f.a.live, f.b.live];
  const kinds = [ENGINE_KINDS.OLLAMA, ENGINE_KINDS.OPENAI];
  const service = createSellerFreeOffers(() => offers, {
    owner: f.owner,
    nodeId: f.nodeId,
    now: () => f.now,
    ledger: new FreeSellerLedger(f.now - 1, 10),
    receipts: {
      publisher: {
        publish: (record) => {
          observations.push(record);
        },
      },
      engineKind: (index) => kinds[index]!,
    },
  });
  for (let index = 0; index < offers.length; index++) {
    const quote = await f.quote(offers[index]!, index + 1);
    if (!quote.result || !('offer' in quote.result)) assert.fail();
    const request = buildFreeExecutionRequest(quote.result.offer, {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic' }],
      maxTokens: 10,
    });
    assert.ok(
      (await service.respond(request, BUYER_NODE, new AbortController().signal))
        .result,
    );
  }
  assert.equal(observations.length, 2);
  assert.deepEqual(
    observations.map((value) => value.engineKind),
    kinds,
  );
  assert.equal(JSON.stringify(observations).includes('synthetic'), false);
});
