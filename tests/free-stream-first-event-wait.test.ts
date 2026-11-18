// A streaming seller may stay silent longer than the per-frame ingress deadline while it reads a long
// prompt or prepares a tool call; the buyer must keep waiting within its request budget instead of
// cancelling. Native encrypted loopback with synthetic policy and signatures; no engine is started.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createControlQuote } from '@gyblos/core/control-quotes';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  FREE_STREAM,
} from '@gyblos/protocol/constants';
import {
  buildFreeExecutionRequest,
  freeExecutionDigest,
} from '@gyblos/protocol/free-execution';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';
import { IROH_DEADLINES } from '@gyblos/transport-iroh/constants';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { controlFixture } from './support/control-fixture';
import { endpoint, within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

const SILENCE_MS = IROH_DEADLINES.ingressMs + 1_500;

void test(
  'streaming buyer waits past the ingress deadline for a slow first event and a silent tool turn',
  { skip: NATIVE_CAPABILITY.transportSkip, timeout: 4 * SILENCE_MS },
  async () => {
    const source = await controlFixture(true);
    const seller = await endpoint();
    const buyer = await endpoint();
    seller.setAlpns([[...Buffer.from(FREE_STREAM.alpn)]]);
    const now = Date.now();
    source.setNow(now);
    source.setReadiness({ observedAt: now, validUntil: now + 60_000 });
    source.catalog.issuedAt = now;
    source.catalog.expiresAt = now + 120_000;
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
    let withDeltas = true;
    const server = serveIroh(seller, 'http://127.0.0.1:1', false, undefined, {
      async respond() {
        throw new Error('complete response channel must not execute');
      },
      async stream(_value, _peer, _signal, onDelta) {
        const header = {
          version: FREE_EXECUTION.version,
          requestId: request.requestId,
          requestDigest: await freeExecutionDigest(request),
        };
        // Reading the prompt: nothing is sent for longer than one ingress deadline.
        await delay(SILENCE_MS);
        if (withDeltas) await onDelta('answer');
        return {
          ...header,
          result: {
            // A silent turn (like a tool call) carries no text the deltas did not deliver.
            text: withDeltas ? 'answer' : '',
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
      for (const deltas of [true, false]) {
        withDeltas = deltas;
        const seen: string[] = [];
        const client = createFreeExecutionClient(buyer, seller.addr(), trust, {
          now: () => now,
          onDelta: async (text) => {
            seen.push(text);
          },
        });
        const result = await within(client.execute(request), 2 * SILENCE_MS);
        assert.equal(result.text, deltas ? 'answer' : '');
        assert.deepEqual(seen, deltas ? ['answer'] : []);
        await client.settled();
      }
    } finally {
      await buyer.close();
      await server.close();
    }
  },
);
