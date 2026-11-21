// Product buyer/seller fixture uses a deterministic synthetic engine and actual SDK/private journals over TCP.
import { createBuyerBatchSession } from '@gyblos/node/batch-buyer';
import {
  createSellerBatchSession,
  type SellerBatchSessionOptions,
} from '@gyblos/node/batch-seller';
import { recountedMeter } from '@gyblos/node/free-meter';
import type { BuyerReceiptEvidence } from '@gyblos/node/receipts';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import type { RouteProbe } from '@gyblos/transport-iroh';

import { batchOfferFixture } from './batch-iroh-offer';
import { batchLoopback } from './batch-loopback';
import { sessionRig } from './batch-session';

export const BLOCK_TEXT = 'aa bb cc';
export const blockTestMeter: ChatTokenizer = {
  input: () => 2,
  chat: () => 2,
  count: (text) => text.length,
  stablePrefix(text, target = Number.MAX_SAFE_INTEGER) {
    let characters = 0;
    for (const match of text.matchAll(/[A-Za-z0-9] /g)) {
      characters = match.index + 1;
      if (characters >= target) break;
    }
    return { characters, tokens: characters };
  },
};
export function configureBlockEngine(
  offers: Awaited<ReturnType<typeof batchOfferFixture>>,
) {
  offers.live.meter = recountedMeter(blockTestMeter);
  offers.generate(async (input) => {
    for (const text of BLOCK_TEXT) {
      input.signal?.throwIfAborted();
      await input.onText?.(text);
    }
    return {
      text: BLOCK_TEXT,
      finishReason: ENGINE_DONE_REASONS.STOP,
      usage: {
        inputTokens: 2,
        outputTokens: BLOCK_TEXT.length,
        totalDurationNs: 0,
        loadDurationNs: 0,
        inputDurationNs: 0,
        outputDurationNs: 0,
      },
    };
  });
}
export async function blockProduct(
  options: Pick<SellerBatchSessionOptions, 'telemetry' | 'receipts'> & {
    receipt?: (evidence: BuyerReceiptEvidence) => void | Promise<void>;
    // false runs the same paid session without blocks (no stable-prefix meter, no block transport).
    blocks?: boolean;
    route?: RouteProbe;
  } = {},
) {
  const f = await sessionRig({
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
    transaction: 'SyntheticClose',
  });
  const offers = await batchOfferFixture(f.terms, f.owner, f.now);
  configureBlockEngine(offers);
  const service = createSellerBatchSession({
    telemetry: options.telemetry,
    receipts: options.receipts,
    session: f.seller(),
    terms: f.terms,
    offers: () => [offers.live],
    now: f.now,
    blockTargetTokens: 2,
  });
  const blocks = options.blocks ?? true;
  const wire = await batchLoopback(service, f.terms, blocks, options.route);
  const buyer = createBuyerBatchSession({
    ...wire,
    terms: f.terms,
    buyer: f.buyer,
    meter: blocks
      ? blockTestMeter
      : { ...blockTestMeter, stablePrefix: undefined },
    now: f.now,
    unresolved: async () => false,
    verify: async () => {},
    observe: f.sellerOptions.observe,
    receipt: options.receipt,
  });
  return {
    f,
    buyer,
    offers,
    wire,
    async close() {
      await buyer.disconnect();
      await buyer.settled();
      await wire.close();
      await f.dispose();
    },
  };
}
