// The buyer's paid execution: terms from the signed offer plus the network's own fee, one authorization
// per attempt, failover only while nothing left the buyer, the charge recounted and the settlement
// checked against the buyer's own count. Fakes for selection, payment, transport and meter.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PROTOCOL_FEE } from '@gyblos/config';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import {
  paidExecutionDigest,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
} from '@gyblos/protocol/paid/constants';
import {
  PaymentError,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentTerms,
} from '@gyblos/protocol/payment';
import { PaidClientError } from '@gyblos/transport-iroh/paid-client';

import { PAID_BUYER_CODES } from '../apps/buyer/src/constants';
import {
  executeBuyerPaid,
  PAID_VERDICTS,
  type PaidBuyerDependencies,
  type PaidWinner,
} from '../apps/buyer/src/paid-execution';
import { paidSource } from './support/paid-fixture';

const INPUT = {
  messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Hello' }],
  maxTokens: 50,
};

type Script = (
  request: PaidExecutionRequest,
  onDelta: (text: string) => Promise<void>,
) => Promise<PaidExecutionResponse>;

async function setup() {
  const source = await paidSource();
  const quote = source.paid.quote;
  const winners: PaidWinner[] = [
    { nodeId: 'a'.repeat(64), quote },
    { nodeId: 'b'.repeat(64), quote },
  ];
  const calls = {
    authorize: [] as PaymentTerms[],
    receipts: [] as { charged: string }[],
    executed: [] as string[],
  };
  // Errors for successive authorize calls; an empty slot authorizes.
  const authorizeErrors: unknown[] = [];
  let receiptError: unknown;
  const payment: PaymentClient = {
    async authorize(terms) {
      calls.authorize.push(terms);
      const error = authorizeErrors.shift();
      if (error) throw error;
      return {
        channelId: `chan${calls.authorize.length}`.padEnd(32, 'c'),
        payer: terms.buyer,
        requestDigest: terms.requestDigest,
        maxAtomic: terms.maxAtomic,
        payload: Buffer.from('open').toString('base64'),
      };
    },
    async checkReceipt(_authorization, _settlement, expected) {
      calls.receipts.push({ charged: expected });
      if (receiptError) throw receiptError;
    },
    reconcile: async () => [],
  };
  const scripts: Script[] = [];
  let unresolved = false;
  const recorded: unknown[] = [];
  const dependencies: PaidBuyerDependencies = {
    enter: () => () => {},
    unresolved: async () => unresolved,
    select: async (excluded) => {
      const winner = winners.find((each) => !excluded.has(each.nodeId));
      if (!winner) throw new Error('no seller');
      return winner;
    },
    payment,
    fee: PROTOCOL_FEE,
    // One token per character, so charges are easy to read.
    meter: {
      input: () => 4,
      count: (text) => [...text].length,
    },
    async execute(winner, request, _signal, onDelta) {
      calls.executed.push(winner.nodeId);
      const script = scripts.shift();
      if (!script) throw new Error('unscripted');
      return script(request, onDelta);
    },
    record: async (outcome) => {
      recorded.push(outcome);
    },
  };
  return {
    quote,
    dependencies,
    calls,
    recorded,
    scripts,
    setUnresolved: (value: boolean) => {
      unresolved = value;
    },
    failNextAuthorize: (error: unknown) => {
      authorizeErrors.push(error);
    },
    setReceiptError: (error: unknown) => {
      receiptError = error;
    },
  };
}

async function header(request: PaidExecutionRequest) {
  return {
    version: PAID_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await paidExecutionDigest(request),
  };
}

// A seller that streams the text, charges `charged` and settles it.
function settles(text: string, charged: string): Script {
  return async (request, onDelta) => {
    await onDelta(text);
    return {
      ...(await header(request)),
      result: {
        text,
        usage: { inputTokens: 4, outputTokens: [...text].length },
        finishReason: ENGINE_DONE_REASONS.STOP,
      },
      charge: {
        inputTokens: 4,
        outputTokens: [...text].length,
        chargedAtomic: charged,
      },
      payment: {
        settlement: {
          channelId: request.payment.channelId,
          chargedAtomic: charged,
          refundedAtomic: String(
            BigInt(request.payment.maxAtomic) - BigInt(charged),
          ),
          sellerAtomic: '0',
          feeAtomic: '0',
          transaction: 't'.repeat(64),
        },
      },
    };
  };
}

void test('terms come from the signed offer and the network fee; a matching settlement is checked', async () => {
  const buyer = await setup();
  buyer.scripts.push(settles('Hi.', '1'));
  const deltas: string[] = [];
  const outcome = await executeBuyerPaid(
    INPUT,
    buyer.dependencies,
    undefined,
    async (text) => {
      deltas.push(text);
    },
  );
  const offer = buyer.quote.offer;
  assert.deepEqual(buyer.calls.authorize, [
    {
      network: offer.network,
      mint: offer.mint,
      payTo: offer.payTo,
      feePayer: offer.feePayer,
      authorizer: offer.authorizer,
      protocolFeeBps: PROTOCOL_FEE.bps,
      treasury: PROTOCOL_FEE.treasury,
      buyer: offer.buyer,
      requestDigest: offer.requestDigest,
      maxAtomic: offer.maxAtomic,
      expiresAt: offer.expiresAt,
    },
  ]);
  assert.deepEqual(deltas, ['Hi.']);
  assert.equal(outcome.verdict, PAID_VERDICTS.SETTLED);
  // The buyer's own count: 4 input and 3 output tokens at the quoted prices.
  assert.equal(outcome.recount.outputTokens, 3);
  assert.deepEqual(buyer.calls.receipts, [
    { charged: outcome.recount.chargedAtomic },
  ]);
});

void test('nothing is paid while an earlier channel is unresolved', async () => {
  const buyer = await setup();
  buyer.setUnresolved(true);
  await assert.rejects(executeBuyerPaid(INPUT, buyer.dependencies), {
    code: PAID_BUYER_CODES.UNRESOLVED,
  });
  assert.equal(buyer.calls.authorize.length, 0);
});

void test('failover happens only while nothing left the buyer', async () => {
  // Untrusted terms, an unsent request and a refusal before any deposit move to the next seller.
  for (const first of [
    'untrusted',
    new PaidClientError(PAID_EXECUTION_CODES.TIMEOUT, false),
    'refused',
  ] as const) {
    const buyer = await setup();
    if (first === 'untrusted') {
      buyer.failNextAuthorize(
        new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
      );
    } else if (first === 'refused')
      buyer.scripts.push(async (request) => ({
        ...(await header(request)),
        error: { code: PAID_EXECUTION_CODES.PAYMENT_REJECTED },
      }));
    else
      buyer.scripts.push(async () => {
        throw first;
      });
    buyer.scripts.push(settles('Hi.', '1'));
    const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
    assert.equal(outcome.verdict, PAID_VERDICTS.SETTLED, String(first));
    assert.equal(outcome.winner.nodeId, 'b'.repeat(64));
  }
  // Once the request may have reached the seller, a deposit may exist: no second payment.
  const buyer = await setup();
  buyer.scripts.push(async () => {
    throw new PaidClientError(PAID_EXECUTION_CODES.TIMEOUT, true);
  });
  await assert.rejects(executeBuyerPaid(INPUT, buyer.dependencies), {
    code: PAID_EXECUTION_CODES.TIMEOUT,
  });
  assert.equal(buyer.calls.authorize.length, 1);
  assert.equal(buyer.calls.executed.length, 1);
});

void test('pending and lapsed payments are left to reconciliation, without a receipt check', async () => {
  for (const [payment, verdict] of [
    ['pending', PAID_VERDICTS.PENDING],
    ['lapsed', PAID_VERDICTS.LAPSED],
  ] as const) {
    const buyer = await setup();
    buyer.scripts.push(async (request, onDelta) => {
      const settled = await settles('Hi.', '1')(request, onDelta);
      return {
        ...settled,
        payment:
          payment === 'pending'
            ? {
                pending: {
                  channelId: request.payment.channelId,
                  chargedAtomic: '1',
                  transaction: null,
                },
              }
            : { lapsed: { channelId: request.payment.channelId } },
      };
    });
    const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
    assert.equal(outcome.verdict, verdict);
    assert.equal(buyer.calls.receipts.length, 0);
  }
});

void test('a charge above the buyer own count is recorded as a dispute', async () => {
  const buyer = await setup();
  buyer.scripts.push(settles('Hi.', '2'));
  buyer.setReceiptError(new PaymentError(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH));
  const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
  assert.equal(outcome.verdict, PAID_VERDICTS.DISPUTED);
  // The receipt is checked against the buyer's own count, never the seller's claim.
  assert.deepEqual(buyer.calls.receipts, [
    { charged: outcome.recount.chargedAtomic },
  ]);
  assert.notEqual(
    outcome.terminal.charge?.chargedAtomic,
    outcome.recount.chargedAtomic,
  );
  assert.deepEqual(buyer.recorded, [outcome]);
});

void test('an unreachable chain leaves the settlement unverified, not disputed', async () => {
  const buyer = await setup();
  buyer.scripts.push(settles('Hi.', '1'));
  buyer.setReceiptError(new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE));
  const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
  assert.equal(outcome.verdict, PAID_VERDICTS.UNVERIFIED);
  assert.deepEqual(buyer.recorded, []);
});

void test('a pending charge above the buyer own count is a dispute', async () => {
  const buyer = await setup();
  buyer.scripts.push(async (request, onDelta) => ({
    ...(await settles('Hi.', '2')(request, onDelta)),
    payment: {
      pending: {
        channelId: request.payment.channelId,
        chargedAtomic: '2',
        transaction: null,
      },
    },
  }));
  const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
  assert.equal(outcome.verdict, PAID_VERDICTS.DISPUTED);
  assert.equal(buyer.recorded.length, 1);
});

void test('a journal failure stops the request, and with no seller left nothing is paid', async () => {
  const buyer = await setup();
  buyer.failNextAuthorize(
    new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
  );
  await assert.rejects(executeBuyerPaid(INPUT, buyer.dependencies), {
    code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
  });
  const none = await setup();
  none.failNextAuthorize(new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS));
  none.failNextAuthorize(new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS));
  none.dependencies.select = async (excluded) => {
    for (const nodeId of ['a'.repeat(64), 'b'.repeat(64)])
      if (!excluded.has(nodeId)) return { nodeId, quote: none.quote };
    return { nodeId: 'a'.repeat(64), quote: none.quote };
  };
  await assert.rejects(executeBuyerPaid(INPUT, none.dependencies), {
    code: PAID_BUYER_CODES.UNAVAILABLE,
  });
  assert.equal(none.calls.executed.length, 0);
});

void test('the buyer serves one paid request at a time and always releases its slot', async () => {
  const buyer = await setup();
  let held = 0;
  buyer.dependencies.enter = () => {
    held++;
    return () => {
      held--;
    };
  };
  buyer.setUnresolved(true);
  await assert.rejects(executeBuyerPaid(INPUT, buyer.dependencies));
  assert.equal(held, 0);
});
