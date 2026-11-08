// Exercises control ALPN dispatch through native Iroh admission on loopback when available.
// Ephemeral unfunded identities only: no relay, engine, HTTP forwarding or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { ROUTES } from '@gyblos/config';
import {
  CONTROL_ALPN,
  CONTROL_CODES,
  CONTROL_PAID_ALPN,
  GYBLOS_ALPN,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import { createControlTransport } from '@gyblos/transport-iroh/control-client';

import {
  nativeControlFixture as fixture,
  holdNativeConnection,
} from './support/native-control';
import { within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

void test(
  'native control fetches catalog/presence and exact quote while paid HTTP v2 stays unsupported',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const run = await fixture();
    try {
      await within(run.client.getCatalog());
      await within(run.client.getPresence());
      const quote = await within(run.client.requestOffer(run.request.params));
      assert.equal(quote.offer.buyerNodeId, run.buyer.id().toString());
      assert.equal(quote.offer.reasoning, REASONING_LEVELS.OFF);
      assert.equal(quote.offer.protocol, CONTROL_PAID_ALPN);
      assert.equal(run.httpRequests, 0);
      run.setReadiness({ busy: true });
      await assert.rejects(run.client.requestOffer(run.request.params), {
        code: CONTROL_CODES.BUSY,
      });
      await assert.rejects(
        run.client.requestOffer({
          ...run.request.params,
          reasoning: REASONING_LEVELS.HIGH,
        }),
        { code: CONTROL_CODES.LEVEL },
      );
      await assert.rejects(
        within(
          run.buyer.connect(run.seller.addr(), [
            ...Buffer.from(CONTROL_PAID_ALPN),
          ]),
        ),
      );
    } finally {
      await run.close();
    }
  },
);
void test(
  'native NodeId admission allows one control and one data connection; a second data connection is refused',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (context) => {
    const run = await fixture();
    let held: Awaited<ReturnType<typeof holdNativeConnection>> | undefined;
    let phase = 'first data stream acknowledgement';
    try {
      held = await holdNativeConnection(run, GYBLOS_ALPN);
      // A server-acknowledged data lease coexists with this peer's separate control lease.
      phase = 'control catalog with held data lease';
      await within(run.client.getCatalog());
      phase = 'second data connection';
      const second = await within(
        run.buyer.connect(run.seller.addr(), [...Buffer.from(GYBLOS_ALPN)]),
      );
      phase = 'second data refusal';
      await within(second.closed());
      assert.equal(held.connection.closeReason(), null);
      phase = 'complete';
    } finally {
      context.diagnostic(`Native admission phase: ${phase}`);
      try {
        await held?.close();
      } finally {
        await run.close();
      }
    }
  },
);
void test(
  'native NodeId admission still refuses a second concurrent control connection from the same peer',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const run = await fixture();
    let held: Awaited<ReturnType<typeof holdNativeConnection>> | undefined;
    try {
      held = await holdNativeConnection(run, CONTROL_ALPN);
      const second = await within(
        run.buyer.connect(run.seller.addr(), [...Buffer.from(CONTROL_ALPN)]),
      );
      await within(second.closed());
      assert.equal(held.connection.closeReason(), null);
    } finally {
      try {
        await held?.close();
      } finally {
        await run.close();
      }
    }
  },
);
void test(
  'native oversized and slow control frames close connections before any HTTP forwarding',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    for (const bytes of [[0, 1, 0, 0], [0]]) {
      const run = await fixture(40);
      try {
        const connection = await within(
          run.buyer.connect(run.seller.addr(), [...Buffer.from(CONTROL_ALPN)]),
        );
        const stream = await connection.openBi();
        await stream.send.writeAll(bytes);
        await within(connection.closed());
      } finally {
        await run.close();
      }
    }
  },
);

void test(
  'native selected control quote closes before v1 HTTP and idle HTTP retires before the next control race',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const run = await fixture();
    try {
      const { selectBuyerQuote } = await import('@gyblos/buyer/selection');
      const { SELLER_BADGES } = await import('@gyblos/core/constants');
      const { createIrohTransport } =
        await import('@gyblos/transport-iroh/iroh-client');
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
            directAddresses: [],
          },
        ],
      };
      const dependencies = {
        buyer: run.request.params.buyer,
        trusted: run.catalog,
        stats: new Map(),
        now: run.context.now,
        windowMs: 2000,
        async connect() {
          return createBuyerControlClient(
            createControlTransport(
              run.buyer,
              run.seller.addr(),
              run.catalog.nodeId,
              { queryMs: 1000 },
            ),
            { ...run.trust(), now: run.context.now },
          );
        },
      };
      assert.equal(
        (await within(selectBuyerQuote(config, dependencies))).ok,
        true,
      );
      assert.equal(run.httpRequests, 0);
      const http = createIrohTransport(
        run.buyer,
        run.seller.addr(),
        run.catalog.nodeId,
      );
      const response = await within(
        http.exchange({
          method: 'POST',
          path: ROUTES.inference,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"synthetic":true}'),
        }),
      );
      assert.equal(response.status, 403);
      assert.equal(run.httpRequests, 1);
      assert.equal(await http.retireIdle(), true);
      assert.equal(
        (await within(selectBuyerQuote(config, dependencies))).ok,
        true,
      );
      assert.equal(run.httpRequests, 1);
    } finally {
      await run.close();
    }
  },
);

void test(
  'native HTTP-discovered trusted seller passes persistent replay admission before quote-only v1 authorization guard',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const run = await fixture();
    const { discoveryHome, discoveryResponse } =
      await import('./support/buyer-discovery');
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
      let fetches = 0;
      const guard = runtimeProxySelection(
        {
          config,
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
      assert.deepEqual(
        await guard.admit(body, true, new AbortController().signal),
        { ok: true },
      );
      assert.equal(fetches, 1);
      assert.equal(run.httpRequests, 0);
    } finally {
      await home.close();
      await run.close();
    }
  },
);
