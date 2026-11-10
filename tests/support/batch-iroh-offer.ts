// Synthetic quotes, recounting engine and public capabilities for session acceptance; no real model.
import { createSignableMessage, type MessagePartialSigner } from '@solana/kit';

import { recountedMeter } from '@gyblos/node/free-meter';
import type { LiveSellerOffer } from '@gyblos/node/seller-offer-set';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import type { EngineInput, EngineResult } from '@gyblos/protocol/engine';
import { signOfferV2 } from '@gyblos/protocol/offer-v2';
import type { PaymentSessionTerms } from '@gyblos/protocol/payment-session';

import { paidSource } from './paid-fixture';

export async function batchOfferFixture(
  terms: PaymentSessionTerms,
  owner: MessagePartialSigner,
  now: () => number,
) {
  const source = await paidSource();
  let generations = 0;
  let busy = false;
  let down = false;
  let generate: ((input: EngineInput) => Promise<EngineResult>) | undefined;
  const meter = { input: () => 2, count: (text: string) => text.length };
  const base: InferenceOfferV2 = {
    ...source.paid.quote.offer,
    owner: terms.owner,
    nodeId: terms.sellerNodeId,
    buyer: terms.buyer,
    buyerNodeId: terms.buyerNodeId,
    network: terms.network,
    mint: terms.mint,
    payTo: terms.payTo,
    feePayer: terms.feePayer,
    authorizer: terms.authorizer,
    issuedAt: now(),
    expiresAt: now() + 30000,
    prices: { inputAtomicPerMtok: '8000000', outputAtomicPerMtok: '8000000' },
    maxAtomic: '200',
    maxTokens: 10,
    endpoint: { relayUrl: null, directAddresses: [] },
    relayOnly: false,
    availability: {
      ...source.paid.quote.offer.availability,
      observedAt: now(),
    },
  };
  const live: LiveSellerOffer = {
    index: 0,
    selection: base.selection,
    model: base.model,
    capabilities: base.capabilities,
    meteringMode: base.meteringMode,
    offer: {
      kind: OFFER_PRICING_KINDS.PAID,
      modelId: base.selection.modelId,
      reasoning: [REASONING_LEVELS.OFF],
      prices: base.prices,
    },
    meter: recountedMeter(meter),
    readiness: () => ({
      generation: 1,
      busy,
      observedAt: now(),
      validUntil: down ? 0 : now() + 60000,
    }),
    observation: { start() {}, async stop() {} },
    engine: {
      capabilities: () => base.capabilities,
      describe: async () => base.model,
      async generate(input) {
        generations++;
        if (generate) return generate(input);
        return {
          text: 'ok!',
          finishReason: ENGINE_DONE_REASONS.STOP,
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            totalDurationNs: 0,
            loadDurationNs: 0,
            inputDurationNs: 0,
            outputDurationNs: 0,
          },
        };
      },
    },
  };
  return {
    base,
    live,
    meter,
    input: {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic input' }],
      maxTokens: 10,
    },
    generations: () => generations,
    busy: (value: boolean) => {
      busy = value;
    },
    down: (value: boolean) => {
      down = value;
    },
    generate: (value: typeof generate) => {
      generate = value;
    },
    quote: async (index: number, patch: Partial<InferenceOfferV2> = {}) =>
      signOfferV2(
        {
          ...base,
          requestId: index.toString(16).padStart(32, '0'),
          issuedAt: now(),
          expiresAt: now() + 30000,
          ...patch,
        },
        async (bytes) =>
          (await owner.signMessages([createSignableMessage(bytes)]))[0]![
            owner.address
          ]!,
      ),
  };
}
