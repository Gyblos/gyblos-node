// Fakes for the paid buyer tests: two sellers with their own quotes, a payment client that signs each
// request once, scripted seller terminals, a counting meter and a record log. No network or chain.
import { PROTOCOL_FEE } from '@gyblos/config';
import type {
  PaidBuyerDependencies,
  PaidBuyerRecord,
  PaidWinner,
} from '@gyblos/node/buyer-paid-execution';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import {
  paidExecutionDigest,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';
import {
  PaymentError,
  type PaymentClient,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import { paidSource } from './paid-fixture';

export const INPUT = {
  messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Hello' }],
  maxTokens: 50,
};
export const A = 'a'.repeat(64);
export const B = 'b'.repeat(64);

export type Script = (
  request: PaidExecutionRequest,
  onDelta: (text: string) => Promise<void>,
  signal: AbortSignal,
) => Promise<PaidExecutionResponse>;

// Each seller quotes its own request, as discovery gives every seller a fresh request id.
function quoteFor(quote: SignedOfferV2, digit: string): SignedOfferV2 {
  return {
    ...quote,
    offer: { ...quote.offer, requestDigest: digit.repeat(64) },
  };
}

export async function setup() {
  const source = await paidSource();
  const quote = source.paid.quote;
  const winners: PaidWinner[] = [
    { nodeId: A, quote: quoteFor(quote, '1') },
    { nodeId: B, quote: quoteFor(quote, '2') },
  ];
  const authorize: PaymentTerms[] = [];
  const receipts: string[] = [];
  const discarded: string[] = [];
  const executed: string[] = [];
  const recorded: PaidBuyerRecord[] = [];
  // Errors for successive authorize calls; an empty slot authorizes.
  const authorizeErrors: unknown[] = [];
  const signed = new Set<string>();
  const state: { receiptError?: unknown; held: number } = { held: 0 };
  const payment: PaymentClient = {
    async authorize(terms) {
      authorize.push(terms);
      const error = authorizeErrors.shift();
      if (error) throw error;
      // As the journal does: one signature per request.
      if (signed.has(terms.requestDigest))
        throw new PaymentError(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED);
      signed.add(terms.requestDigest);
      return {
        channelId: `chan${authorize.length}`.padEnd(32, 'c'),
        payer: terms.buyer,
        requestDigest: terms.requestDigest,
        maxAtomic: terms.maxAtomic,
        payload: Buffer.from('open').toString('base64'),
      };
    },
    async checkReceipt(_authorization, _settlement, expected) {
      receipts.push(expected);
      if (state.receiptError) throw state.receiptError;
    },
    reconcile: async () => [],
    async discard(authorization) {
      discarded.push(authorization.requestDigest);
    },
  };
  const scripts: Script[] = [];
  const counts = { output: (text: string) => [...text].length };
  let unresolved = false;
  const dependencies: PaidBuyerDependencies = {
    enter: () => {
      state.held++;
      return () => {
        state.held--;
      };
    },
    unresolved: async () => unresolved,
    select: async (excluded) => {
      const winner = winners.find((each) => !excluded.has(each.nodeId));
      if (!winner) throw new Error('no seller');
      return winner;
    },
    payment,
    fee: PROTOCOL_FEE,
    // One token per character unless a test says otherwise, so charges are easy to read.
    meter: {
      input: () => 4,
      count: (text) => counts.output(text),
    },
    async execute(winner, request, signal, onDelta) {
      executed.push(winner.nodeId);
      const script = scripts.shift();
      if (!script) throw new Error('unscripted');
      return script(request, onDelta, signal);
    },
    record: async (record) => {
      recorded.push(record);
    },
  };
  return {
    winners,
    dependencies,
    calls: { authorize, receipts, executed, discarded },
    recorded,
    scripts,
    counts,
    state,
    setUnresolved: (value: boolean) => {
      unresolved = value;
    },
    failNextAuthorize: (error: unknown) => {
      authorizeErrors.push(error);
    },
  };
}

export async function header(request: PaidExecutionRequest) {
  return {
    version: PAID_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await paidExecutionDigest(request),
  };
}

export function settlement(request: PaidExecutionRequest, charged: string) {
  return {
    channelId: request.payment.channelId,
    chargedAtomic: charged,
    refundedAtomic: String(BigInt(request.payment.maxAtomic) - BigInt(charged)),
    sellerAtomic: '0',
    feeAtomic: '0',
    transaction: 't'.repeat(64),
  };
}

// A seller that streams the text, charges `charged` and settles it. Its own result text and usage
// differ from the stream on purpose: the buyer counts only what it received.
export function settles(text: string, charged: string): Script {
  return async (request, onDelta) => {
    await onDelta(text);
    return {
      ...(await header(request)),
      result: {
        text: `${text} and more`,
        usage: { inputTokens: 9, outputTokens: 99 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      },
      charge: { inputTokens: 9, outputTokens: 99, chargedAtomic: charged },
      payment: { settlement: settlement(request, charged) },
    };
  };
}

export function refuses(code: PaidExecutionCode): Script {
  return async (request) => ({ ...(await header(request)), error: { code } });
}
