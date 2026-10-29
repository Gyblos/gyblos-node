// Checks telemetry forwarding through production composition with synthetic offers and a partial SDK double.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Endpoint } from '@number0/iroh';

import { freeBuyerDependencies } from '@gyblos/buyer/free-selection';
import type { PreparedBuyerSelection } from '@gyblos/buyer/selection-runtime';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { FreeSellerLedger } from '@gyblos/core/free-admission';
import { createSellerFreeOffers } from '@gyblos/node/free-offers';
import { ENGINE_KINDS, FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { buildFreeExecutionRequest } from '@gyblos/protocol/free-execution';
import { TELEMETRY_EVENTS } from '@gyblos/protocol/telemetry';

import { freeSellerFixture } from './support/free-seller';
import { localTelemetry } from './support/local-telemetry';
import {
  BUYER_NODE,
  offerControlFixture,
} from './support/seller-offer-control';

void test('seller offer composition forwards the correct engine kind for each offer', async () => {
  const run = await offerControlFixture();
  const telemetry = localTelemetry();
  const offers = [run.a.live, run.b.live];
  const kinds = [ENGINE_KINDS.OLLAMA, ENGINE_KINDS.OPENAI];
  const service = createSellerFreeOffers(() => offers, {
    owner: run.owner,
    nodeId: run.nodeId,
    now: () => run.now,
    ledger: new FreeSellerLedger(run.now - 1, 10),
    telemetry: { ...telemetry, engineKind: (index) => kinds[index]! },
  });
  for (let index = 0; index < offers.length; index++) {
    const quoted = await run.quote(offers[index]!, index + 1);
    if (!quoted.result || !('offer' in quoted.result)) assert.fail();
    const request = buildFreeExecutionRequest(quoted.result.offer, {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
      maxTokens: 10,
    });
    assert.ok(
      (await service.respond(request, BUYER_NODE, new AbortController().signal))
        .result,
    );
  }
  const completed = telemetry.events.filter(
    (event) => event.type === TELEMETRY_EVENTS.COMPLETED,
  );
  assert.equal(completed.length, 2);
  assert.deepEqual(
    completed.map((event) => event.engineKind),
    kinds,
  );
});
void test('buyer composition forwards the sink and authenticated local endpoint identity', async () => {
  const run = await freeSellerFixture();
  const source = run.source;
  const telemetry = localTelemetry();
  const {
    buyer,
    buyerNodeId,
    catalogDigest: _digest,
    ...request
  } = source.request.params;
  const prepared: PreparedBuyerSelection = {
    config: {
      request: {
        ...request,
        lowestReasoning: null,
        minimumBadge: SELLER_BADGES.DECLARED_USAGE,
        retention: [source.catalog.dataPolicy.retention],
      },
      sellers: [],
    },
    stats: { rows: new Map(), save: async () => {} },
    discovery: undefined,
  };
  const endpoint = {
    id: () => ({ toString: () => buyerNodeId }),
  } as unknown as Endpoint;
  const dependencies = freeBuyerDependencies(prepared, {
    endpoint,
    buyer,
    relayOnly: false,
    telemetry: telemetry.sink,
    now: telemetry.now,
  });
  assert.equal(dependencies.telemetry?.sink, telemetry.sink);
  assert.equal(dependencies.telemetry?.buyerNodeId, buyerNodeId);
  assert.deepEqual(
    dependencies.telemetry?.selection,
    prepared.config.request.selection,
  );
  assert.equal(dependencies.telemetry?.now?.(), telemetry.now());
});
