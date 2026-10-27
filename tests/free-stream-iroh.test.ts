// Exercises the streaming ALPN over native encrypted loopback with synthetic policy and owner signatures.
// No engine, HTTP bridge, payment service, real identity or persistent state is started.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_STREAM,
} from '@gyblos/protocol/constants';
import {
  buildFreeExecutionRequest,
  freeExecutionDigest,
} from '@gyblos/protocol/free-execution';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { controlFixture } from './support/control-fixture.js';
import { endpoint, within } from './support/native-fixture.js';
import { NATIVE_CAPABILITY } from './support/native-runtime.js';

void test(
  'native streaming ALPN returns correlated deltas and forwards buyer cancellation to policy',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const source = await controlFixture(true);
    const seller = await endpoint();
    const buyer = await endpoint();
    seller.setAlpns([[...Buffer.from(FREE_STREAM.alpn)]]);
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
    const request = buildFreeExecutionRequest(quote, {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic' }],
      maxTokens: 2,
    });
    let cancelPolicy = false;
    let aborted = () => {};
    const policyAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const server = serveIroh(seller, 'http://127.0.0.1:1', false, undefined, {
      async respond() {
        throw new Error('complete response channel must not execute');
      },
      async stream(value, peer, signal, onDelta) {
        assert.equal(peer, buyer.id().toString());
        assert.equal(
          value && typeof value === 'object' && 'requestId' in value
            ? value.requestId
            : undefined,
          request.requestId,
        );
        const header = {
          version: FREE_EXECUTION.version,
          requestId: request.requestId,
          requestDigest: await freeExecutionDigest(request),
        };
        await onDelta('an');
        if (cancelPolicy) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener('abort', () => resolve(), { once: true });
          });
          aborted();
          return { ...header, error: { code: FREE_EXECUTION_CODES.CANCELLED } };
        }
        await onDelta('swer');
        return {
          ...header,
          result: {
            text: 'answer',
            usage: { inputTokens: 1, outputTokens: 2 },
            finishReason: ENGINE_DONE_REASONS.STOP,
          },
        };
      },
    });
    const trust = {
      owner: source.context.owner,
      nodeId: seller.id().toString(),
    };
    try {
      const deltas: string[] = [];
      const first = createFreeExecutionClient(buyer, seller.addr(), trust, {
        now: () => now,
        onDelta: async (text) => {
          deltas.push(text);
        },
      });
      assert.equal((await within(first.execute(request))).text, 'answer');
      await first.settled();
      assert.deepEqual(deltas, ['an', 'swer']);
      cancelPolicy = true;
      const controller = new AbortController();
      const second = createFreeExecutionClient(buyer, seller.addr(), trust, {
        now: () => now,
        onDelta: async () => {
          controller.abort();
        },
      });
      await assert.rejects(within(second.execute(request, controller.signal)), {
        code: FREE_EXECUTION_CODES.CANCELLED,
        sent: true,
      });
      await second.settled();
      await within(policyAborted);
    } finally {
      await buyer.close();
      await server.close();
    }
  },
);
