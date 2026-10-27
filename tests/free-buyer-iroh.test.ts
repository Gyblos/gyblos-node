// Native select/quote/execute contract through the local HTTP endpoint; fake engine, no payments or index.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { freeBuyerDependencies } from '@gyblos/buyer/free-selection';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';
import { sellerLimits } from '@gyblos/node/node-config-limits';
import { createSellerRecords } from '@gyblos/node/public-records';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import {
  CONTROL_ALPN,
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
} from '@gyblos/protocol/constants';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import { freeSellerFixture } from './support/free-seller.js';
import { endpoint, within } from './support/native-fixture.js';
import { NATIVE_CAPABILITY } from './support/native-runtime.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

void test(
  'native free buyer selects, verifies a quote and returns the answer without v1 trust',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const fixture = await freeSellerFixture();
    const source = fixture.source;
    const now = Date.now();
    source.setNow(now);
    fixture.setNow(now);
    source.setReadiness({ observedAt: now, validUntil: now + 20000 });
    const seller = await endpoint();
    const buyer = await endpoint();
    seller.setAlpns(
      [CONTROL_ALPN, FREE_EXECUTION.alpn].map((value) => [
        ...Buffer.from(value),
      ]),
    );
    source.catalog.nodeId = seller.id().toString();
    source.catalog.issuedAt = now;
    source.catalog.expiresAt = now + 60000;
    source.context.nodeId = source.catalog.nodeId;
    source.context.endpoint = {
      relayUrl: null,
      directAddresses: seller.addr().directAddresses(),
    };
    source.context.relayOnly = false;
    const signer = async (bytes: Uint8Array<ArrayBuffer>) =>
      Uint8Array.from(
        seller
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      );
    source.context.catalog = await signPublicV2(source.catalog, signer);
    let sequence = source.catalog.sequence;
    const records = await createSellerRecords({
      template: source.catalog,
      signer,
      now: source.context.now,
      validUntil: () => source.context.readiness().validUntil,
      sequence: {
        next: async (minimum = 0) => {
          sequence = Math.max(sequence, minimum) + 1;
          return sequence;
        },
      },
    });
    source.context.catalog = records.current();
    const server = serveSellerTransport(
      seller,
      {
        offer: fixture.options.offer,
        records,
        service: createSellerControlService({
          context: source.context,
          ownerSigner: source.ownerSigner,
          nodeSigner: signer,
          records,
        }),
      },
      {
        ...fixture.options,
        engine: {
          ...fixture.options.engine,
          capabilities: () => fixture.options.capabilities,
        },
        nodeId: seller.id().toString(),
        startedAt: now - 1,
        relayOnly: false,
        limits: sellerLimits(),
      },
    );
    const {
      buyer: _buyer,
      buyerNodeId: _nodeId,
      catalogDigest: _digest,
      ...request
    } = source.request.params;
    const config: BuyerSelectionConfig = {
      request: {
        ...request,
        maxTokens: 10,
        lowestReasoning: null,
        minimumBadge: SELLER_BADGES.DECLARED_USAGE,
        retention: [source.catalog.dataPolicy.retention],
      },
      sellers: [
        {
          owner: source.catalog.owner,
          nodeId: source.catalog.nodeId,
          relayUrl: null,
          directAddresses: seller.addr().directAddresses(),
        },
      ],
    };
    const prepared = {
      config,
      stats: {
        rows: new Map<string, LocalSellerStats>(),
        save: async () => {},
      },
      discovery: undefined,
    };
    const dependencies = freeBuyerDependencies(prepared, {
      endpoint: buyer,
      buyer: source.request.params.buyer,
      relayOnly: false,
      now: source.context.now,
    });
    const host = await startFreeBuyerHttp(
      (input, signal) => executeBuyerFree(input, dependencies, signal),
      { selection: request.selection, maxTokens: 10 },
      { port: 0 },
    );
    try {
      assert.equal(fixture.calls(), 0);
      const response = await within(
        fetch(host.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: request.selection.modelId,
            messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
            max_tokens: 10,
          }),
        }),
      );
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.choices[0].message.content, 'answer');
      assert.equal(fixture.calls(), 1);
      let engineBegan = () => {};
      const began = new Promise<void>((resolve) => {
        engineBegan = resolve;
      });
      let releaseEngine = () => {};
      const released = new Promise<void>((resolve) => {
        releaseEngine = resolve;
      });
      fixture.setRun(async () => {
        engineBegan();
        await released;
        return {
          text: 'answer',
          finishReason: ENGINE_DONE_REASONS.STOP,
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            totalDurationNs: 0,
            loadDurationNs: 0,
            inputDurationNs: 0,
            outputDurationNs: 0,
          },
        };
      });
      const body = JSON.stringify({
        model: request.selection.modelId,
        messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
        max_tokens: 10,
      });
      const overlapping = Promise.all([
        fetch(host.url, { method: 'POST', headers: JSON_HEADERS, body }),
        fetch(host.url, { method: 'POST', headers: JSON_HEADERS, body }),
      ]);
      try {
        assert.equal(
          await within(
            Promise.race([
              began.then(() => 'engine'),
              overlapping.then(() => 'done'),
            ]),
          ),
          'engine',
        );
        releaseEngine();
        const responses = await within(overlapping);
        assert.deepEqual(
          responses.map((item) => item.status).sort(),
          [200, 429],
        );
        const rejected = responses.find((item) => item.status === 429)!;
        assert.equal((await rejected.json()).error.code, FREE_BUYER_CODES.BUSY);
        for (const row of prepared.stats.rows.values())
          assert.equal(row.failures, 0);
        assert.equal(fixture.calls(), 2);
      } finally {
        releaseEngine();
        await overlapping;
      }
    } finally {
      await host.close();
      await buyer.close();
      await server.close();
    }
  },
);
