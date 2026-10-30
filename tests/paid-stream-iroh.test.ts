// Exercises the paid stream ALPN over native encrypted loopback with a synthetic service and owner
// signatures: the settled terminal reaches the buyer, and a buyer leaving still lets the service
// settle. No engine, payment adapter, chain or persistent state is started.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import {
  buildPaidExecutionRequest,
  paidExecutionDigest,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from '@gyblos/protocol/paid/constants';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';
import { createPaidExecutionClient } from '@gyblos/transport-iroh/paid-client';

import { controlFixture } from './support/control-fixture';
import { endpoint, within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';
import { CHARGE, RESULT, settled } from './support/paid-fixture';

void test(
  'native paid stream returns the settled terminal and settles after the buyer leaves',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const source = await controlFixture(false);
    const seller = await endpoint();
    const buyer = await endpoint();
    seller.setAlpns([[...Buffer.from(PAID_STREAM.alpn)]]);
    const now = Date.now();
    source.setNow(now);
    source.setReadiness({ observedAt: now, validUntil: now + 20000 });
    source.catalog.issuedAt = now;
    source.catalog.expiresAt = now + 60000;
    source.catalog.nodeId = seller.id().toString();
    source.context.nodeId = seller.id().toString();
    source.context.remoteNodeId = buyer.id().toString();
    source.request.params.buyerNodeId = buyer.id().toString();
    source.context.catalog = await signPublicV2(source.catalog, async (bytes) =>
      Uint8Array.from(
        seller
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      ),
    );
    source.request.params.catalogDigest = await catalogDigestV2(source.catalog);
    const quote = await createControlQuote(
      source.request,
      source.context,
      source.ownerSigner,
    );
    const paid = buildPaidExecutionRequest(
      quote,
      {
        messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic' }],
        maxTokens: 2,
      },
      {
        channelId: 'c'.repeat(64),
        payer: quote.offer.buyer,
        requestDigest: quote.offer.requestDigest,
        maxAtomic: quote.offer.maxAtomic,
        payload: Buffer.from('open').toString('base64'),
      },
    );
    const header = {
      version: PAID_EXECUTION.version,
      requestId: paid.requestId,
      requestDigest: await paidExecutionDigest(paid),
    };
    let leave = false;
    let settledAfterLeaving = () => {};
    const settledLate = new Promise<void>((resolve) => {
      settledAfterLeaving = resolve;
    });
    const server = serveIroh(
      seller,
      'http://127.0.0.1:1',
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        async stream(_value, peer, signal, onDelta) {
          assert.equal(peer, buyer.id().toString());
          await onDelta('Hi');
          if (leave) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
            });
            settledAfterLeaving();
            return {
              ...header,
              error: {
                code: PAID_EXECUTION_CODES.CANCELLED,
                delivered: { outputTokens: 1 },
              },
              charge: { ...CHARGE, outputTokens: 1 },
              payment: settled(paid, CHARGE.chargedAtomic),
            };
          }
          await onDelta('.');
          return {
            ...header,
            result: RESULT,
            charge: CHARGE,
            payment: settled(paid, CHARGE.chargedAtomic),
          };
        },
      },
    );
    const trust = {
      owner: source.context.owner,
      nodeId: seller.id().toString(),
    };
    try {
      const deltas: string[] = [];
      const first = createPaidExecutionClient(buyer, seller.addr(), trust, {
        now: () => now,
        onDelta: async (text) => {
          deltas.push(text);
        },
      });
      const terminal = await within(first.execute(paid));
      await first.settled();
      assert.deepEqual(deltas, ['Hi', '.']);
      assert.deepEqual(terminal.charge, CHARGE);
      assert.equal(terminal.payment?.settlement?.chargedAtomic, '1');
      leave = true;
      const controller = new AbortController();
      const second = createPaidExecutionClient(buyer, seller.addr(), trust, {
        now: () => now,
        onDelta: async () => {
          controller.abort();
        },
      });
      await assert.rejects(within(second.execute(paid, controller.signal)), {
        code: PAID_EXECUTION_CODES.CANCELLED,
        sent: true,
      });
      await second.settled();
      await within(settledLate);
    } finally {
      await buyer.close();
      await server.close();
    }
  },
);
