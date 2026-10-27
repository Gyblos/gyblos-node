// Native encrypted discovery-to-quote identity admission, never execution or payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import { GYBLOS_ALPN } from '@gyblos/protocol/constants';

import { nativeControlFixture as fixture } from './support/native-control.js';
import { NATIVE_CAPABILITY } from './support/native-runtime.js';

void test(
  'native registry identity revocation between quote and authorization stops cached v1 admission without reselection',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const run = await fixture();
    const { discoveryHome, discoveryResponse } =
      await import('./support/buyer-discovery.js');
    const home = await discoveryHome();
    try {
      const { runtimeProxySelection } =
        await import('@gyblos/buyer/selection-runtime');
      const { selectionStats } = await import('@gyblos/buyer/selection-stats');
      const { SELLER_BADGES } = await import('@gyblos/core/constants');
      const catalog = await run.client.getCatalog();
      const presence = await run.client.getPresence();
      const quote = await run.client.requestOffer(run.request.params);
      await run.client.close();
      const {
        buyer: _buyer,
        buyerNodeId: _node,
        catalogDigest: _digest,
        ...request
      } = run.request.params;
      const config = {
        request: {
          ...request,
          lowestReasoning: null,
          minimumBadge: SELLER_BADGES.DECLARED_USAGE,
          retention: [run.catalog.dataPolicy.retention],
        },
        sellers: [
          {
            owner: run.catalog.owner,
            nodeId: run.catalog.nodeId,
            relayUrl: null,
            directAddresses: run.seller.addr().directAddresses(),
          },
        ],
        discovery: { baseUrl: 'https://index.test', maxPages: 1 },
      };
      // Synthetic legacy trust fixture only; product never converts a v2 quote into a v1 offer.
      const trusted = {
        ...quote.offer,
        schemaVersion: 1,
        protocol: GYBLOS_ALPN,
        prices: { inputAtomic: '1', outputAtomic: '2' },
      };
      const { IDENTITY_TRUST_SOURCES, IDENTITY_POLICY_CODES } =
        await import('@gyblos/core/identity-policy');
      let identityAllowed = true;
      let identityChecks = 0;
      let fetches = 0;
      const guard = runtimeProxySelection(
        {
          config: { ...config, identity: { rpcUrl: 'https://rpc.invalid' } },
          identity: {
            verify: async () => {
              identityChecks++;
              return identityAllowed
                ? { ok: true, source: IDENTITY_TRUST_SOURCES.REGISTRY }
                : { ok: false, code: IDENTITY_POLICY_CODES.REVOKED };
            },
          },
          stats: await selectionStats(home.environment),
          discovery: home.state,
        },
        {
          endpoint: run.buyer,
          trusted,
          buyer: run.request.params.buyer,
          relayOnly: false,
          retireIdle: async () => true,
          now: run.context.now,
          fetch: async () => {
            fetches++;
            return discoveryResponse([{ catalog, presence }]);
          },
        },
      );
      const body = Buffer.from(
        JSON.stringify({
          requestId: 'synthetic-native',
          maxTokens: request.maxTokens,
        }),
      );
      assert.deepEqual(
        await guard.admit(body, false, new AbortController().signal),
        { ok: true },
      );
      identityAllowed = false;
      const checksBefore = identityChecks;
      assert.deepEqual(
        await guard.admit(body, true, new AbortController().signal),
        { ok: false, code: BUYER_SELECTION_CODES.RECONCILE },
      );
      assert.deepEqual(
        await guard.admit(body, true, new AbortController().signal),
        { ok: false, code: BUYER_SELECTION_CODES.RECONCILE },
      );
      assert.equal(identityChecks, checksBefore + 1);
      assert.equal(fetches, 1);
      assert.equal(run.httpRequests, 0);
    } finally {
      await home.close();
      await run.close();
    }
  },
);
