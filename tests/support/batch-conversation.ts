// Synthetic conversational peers use the real session journals and loopback RPC, never live payments.
import assert from 'node:assert/strict';

import { PROTOCOL_FEE } from '@gyblos/config';
import { renderChat, renderConversation } from '@gyblos/engine-ollama/model';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { recountedMeter } from '@gyblos/node/free-meter';
import {
  createBatchBuyer,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import { BATCH_METHODS } from '@gyblos/protocol/batch-channel';
import type { ChatMessage } from '@gyblos/protocol/chat';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { ChatTokenizer, EngineInput } from '@gyblos/protocol/engine';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import { batchOfferFixture } from './batch-iroh-offer';
import { batchLoopback } from './batch-loopback';
import { sessionRig } from './batch-session';

export const CONVERSATION: readonly ChatMessage[] = [
  { role: FREE_CHAT_ROLES.SYSTEM, content: 's' },
  { role: FREE_CHAT_ROLES.USER, content: 'u' },
  { role: FREE_CHAT_ROLES.ASSISTANT, content: 'a' },
  { role: FREE_CHAT_ROLES.USER, content: 'v' },
];
export const CONVERSATION_INPUT: FreeExecutionBuildInput = {
  messages: CONVERSATION,
  maxTokens: 10,
};

export async function batchConversation(override?: ChatTokenizer) {
  const rig = await sessionRig({
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
    treasury: PROTOCOL_FEE.treasury,
    transaction: 'syntheticClose',
  });
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const meter: ChatTokenizer = override ?? {
    input: (text) => {
      renderChat(text);
      return 2 + text.length;
    },
    chat: (messages) => {
      renderConversation(messages);
      return messages.reduce(
        (sum, message) => sum + 2 + message.content.length,
        0,
      );
    },
    count: (text) => text.length,
  };
  offers.live.meter = recountedMeter(meter);
  const generated: EngineInput[] = [];
  const generate = offers.live.engine.generate.bind(offers.live.engine);
  offers.live.engine.generate = async (input) => {
    generated.push(input);
    return generate(input);
  };
  const service = createSellerBatchSession({
    session: rig.seller(),
    terms: rig.terms,
    offers: () => [offers.live],
    now: rig.now,
  });
  let loseAck = false;
  let alterUsage = false;
  const wire = await batchLoopback(
    {
      async exchange(...args: Parameters<typeof service.exchange>) {
        const result = await service.exchange(...args);
        if ('value' in result && alterUsage)
          result.value.usage.inputTokens = meter.input('v');
        if (args[0].method === BATCH_METHODS.APPROVE && loseAck) {
          loseAck = false;
          throw new Error('Synthetic ACK loss');
        }
        return result;
      },
    },
    rig.terms,
  );
  let financial = rig.buyer;
  let constructions = 0;
  const inspect = () => inspectBatchSession(rig.buyerOptions.paths);
  const make = () =>
    createBuyerSessionManager({
      ...wire,
      policy: {
        depositAtomic: rig.terms.depositAtomic,
        lifetimeMs: 3600000,
        withdrawDelaySeconds: rig.terms.withdrawDelaySeconds,
      },
      inspect,
      backend: async () => {
        constructions++;
        return {
          inspect,
          create: async () => financial,
          observe: rig.sellerOptions.observe,
        };
      },
      destination: () => wire.destination,
      meter,
      now: rig.now,
      unresolved: async () => false,
      verify: async (quote) => {
        assert.equal(quote.offer.owner, rig.terms.owner);
      },
    });
  let buyer = make();
  return {
    rig,
    offers,
    meter,
    service,
    wire,
    generated,
    inspect,
    buyer: () => buyer,
    constructions: () => constructions,
    quote: (index: number, patch: Parameters<typeof offers.quote>[1] = {}) =>
      offers.quote(index, {
        prices: {
          inputAtomicPerMtok: '1000000',
          outputAtomicPerMtok: '1000000',
        },
        ...patch,
      }),
    loseAck: () => {
      loseAck = true;
    },
    alterUsage: () => {
      alterUsage = true;
    },
    async restart() {
      await buyer.close();
      await financial.dispose();
      financial = await createBatchBuyer(rig.buyerOptions);
      buyer = make();
    },
    async close() {
      await buyer.close();
      await wire.close();
      await financial.dispose();
      await rig.dispose();
    },
  };
}
