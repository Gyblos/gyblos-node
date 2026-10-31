// The buyer's paid execution: terms from the signed offer plus the network's own fee, failover only while
// the signed open never left the buyer, and every outcome short of a checked settlement recorded with
// the buyer's own count. Fakes for selection, payment, transport and meter.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PROTOCOL_FEE } from '@gyblos/config';
import {
  FREE_CHAT_ROLES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import { PaidClientError } from '@gyblos/transport-iroh/paid-client';

import { PAID_BUYER_CODES, PAID_VERDICTS } from '../apps/buyer/src/constants';
import { executeBuyerPaid } from '../apps/buyer/src/paid-execution';
import { A, B, INPUT, refuses, settles, setup } from './support/buyer-paid';

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
  const offer = buyer.winners[0]!.quote.offer;
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
  // The buyer's own count of the streamed text, never the seller's usage or result text.
  assert.deepEqual(
    [outcome.recount.inputTokens, outcome.recount.outputTokens],
    [4, 3],
  );
  assert.deepEqual(buyer.calls.receipts, [outcome.recount.chargedAtomic]);
  assert.equal(outcome.recorded, false);
  assert.deepEqual(buyer.recorded, []);
  assert.equal(buyer.state.held, 0);
});

void test('input no paid seller serves, or an unresolved channel, stops before any payment', async () => {
  const buyer = await setup();
  for (const messages of [
    [...INPUT.messages, ...INPUT.messages],
    [{ role: FREE_CHAT_ROLES.SYSTEM, content: 'Hello' }],
    [],
  ])
    await assert.rejects(
      executeBuyerPaid({ ...INPUT, messages }, buyer.dependencies),
      { code: PAID_BUYER_CODES.UNSUPPORTED },
    );
  // A prompt the model's chat template refuses would only fail after paying.
  const meter = buyer.dependencies.meter;
  buyer.dependencies.meter = {
    ...meter,
    input: () => {
      throw new Error('Unsupported prompt for the bounded single-user offer.');
    },
  };
  await assert.rejects(executeBuyerPaid(INPUT, buyer.dependencies), {
    code: PAID_BUYER_CODES.UNSUPPORTED,
  });
  buyer.dependencies.meter = meter;
  buyer.setUnresolved(true);
  await assert.rejects(executeBuyerPaid(INPUT, buyer.dependencies), {
    code: PAID_BUYER_CODES.UNRESOLVED,
  });
  assert.equal(buyer.calls.authorize.length, 0);
  assert.equal(buyer.state.held, 0);
});

void test('failover happens only while the signed open never left the buyer', async () => {
  for (const first of ['untrusted', 'signed', 'unsent'] as const) {
    const buyer = await setup();
    if (first === 'untrusted')
      buyer.failNextAuthorize(
        new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
      );
    else if (first === 'signed')
      buyer.failNextAuthorize(
        new PaymentError(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED),
      );
    else
      buyer.scripts.push(async () => {
        throw new PaidClientError(PAID_EXECUTION_CODES.TIMEOUT, false);
      });
    buyer.scripts.push(settles('Hi.', '1'));
    const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
    assert.equal(outcome.verdict, PAID_VERDICTS.SETTLED, first);
    assert.equal(outcome.winner.nodeId, B, first);
    assert.deepEqual(buyer.recorded, [], first);
  }
});

void test('a refusal after the open reached the seller is recorded, never failed over', async () => {
  for (const code of [
    PAID_EXECUTION_CODES.PAYMENT_REJECTED,
    PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE,
    PAID_EXECUTION_CODES.INTERNAL,
  ]) {
    const buyer = await setup();
    buyer.scripts.push(refuses(code), settles('Hi.', '1'));
    const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
    assert.equal(outcome.verdict, PAID_VERDICTS.REFUSED, code);
    assert.equal(outcome.winner.nodeId, A);
    assert.equal(buyer.calls.authorize.length, 1);
    assert.deepEqual(buyer.recorded, [
      {
        nodeId: A,
        requestDigest: outcome.authorization.requestDigest,
        channelId: outcome.authorization.channelId,
        verdict: PAID_VERDICTS.REFUSED,
        expectedAtomic: '0',
        claimedAtomic: null,
      },
    ]);
  }
});

void test('a request that stops after sending is recorded with what was received, then reported', async () => {
  const buyer = await setup();
  const stop = new PaidClientError(PAID_EXECUTION_CODES.TIMEOUT, true);
  buyer.scripts.push(async (_request, onDelta) => {
    await onDelta('Hi');
    throw stop;
  });
  await assert.rejects(executeBuyerPaid(INPUT, buyer.dependencies), stop);
  assert.equal(buyer.calls.authorize.length, 1);
  assert.equal(buyer.calls.executed.length, 1);
  assert.deepEqual(
    buyer.recorded.map(({ verdict, expectedAtomic, claimedAtomic }) => ({
      verdict,
      expectedAtomic,
      claimedAtomic,
    })),
    [
      {
        verdict: PAID_VERDICTS.INTERRUPTED,
        expectedAtomic: '1',
        claimedAtomic: null,
      },
    ],
  );
  // A caller whose own delivery fails also stops the request after sending.
  const failing = await setup();
  failing.scripts.push(settles('Hi.', '1'));
  await assert.rejects(
    executeBuyerPaid(INPUT, failing.dependencies, undefined, async () => {
      throw new Error('client gone');
    }),
    /client gone/,
  );
  assert.equal(failing.recorded[0]?.verdict, PAID_VERDICTS.INTERRUPTED);
  assert.equal(failing.state.held, 0);
});

void test('pending and lapsed payments are recorded for reconciliation, without a receipt check', async () => {
  for (const [kind, verdict] of [
    ['pending', PAID_VERDICTS.PENDING],
    ['lapsed', PAID_VERDICTS.LAPSED],
  ] as const) {
    const buyer = await setup();
    buyer.scripts.push(async (request, onDelta, signal) => {
      const settled = await settles('Hi.', '1')(request, onDelta, signal);
      const channelId = request.payment.channelId;
      return {
        ...settled,
        payment:
          kind === 'pending'
            ? { pending: { channelId, chargedAtomic: '1', transaction: null } }
            : { lapsed: { channelId } },
      };
    });
    const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
    assert.equal(outcome.verdict, verdict);
    assert.equal(outcome.recorded, true);
    assert.equal(buyer.recorded[0]?.verdict, verdict);
    // A lapsed claim charged nothing, whatever the seller had counted.
    assert.equal(
      buyer.recorded[0]?.claimedAtomic,
      kind === 'pending' ? '1' : null,
    );
    assert.equal(buyer.calls.receipts.length, 0);
  }
});

void test('a claim other than the buyer own count is a dispute, whatever the chain says', async () => {
  for (const charged of ['2', '0']) {
    const buyer = await setup();
    buyer.scripts.push(settles('Hi.', charged));
    // The chain cannot be reached: the claim alone already disagrees.
    buyer.state.receiptError = new PaymentError(
      PAYMENT_ERROR_CODES.UNAVAILABLE,
    );
    const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
    assert.equal(outcome.verdict, PAID_VERDICTS.DISPUTED, charged);
    assert.deepEqual(buyer.recorded, [
      {
        nodeId: A,
        requestDigest: outcome.authorization.requestDigest,
        channelId: outcome.authorization.channelId,
        verdict: PAID_VERDICTS.DISPUTED,
        expectedAtomic: '1',
        claimedAtomic: charged,
      },
    ]);
  }
  const pending = await setup();
  pending.scripts.push(async (request, onDelta, signal) => ({
    ...(await settles('Hi.', '2')(request, onDelta, signal)),
    payment: {
      pending: {
        channelId: request.payment.channelId,
        chargedAtomic: '2',
        transaction: null,
      },
    },
  }));
  const outcome = await executeBuyerPaid(INPUT, pending.dependencies);
  assert.equal(outcome.verdict, PAID_VERDICTS.DISPUTED);
});

void test('a matching claim the chain does not confirm is disputed, or unverified while unreachable', async () => {
  for (const [code, verdict] of [
    [PAYMENT_ERROR_CODES.UNAVAILABLE, PAID_VERDICTS.UNVERIFIED],
    [PAYMENT_ERROR_CODES.RECEIPT_MISMATCH, PAID_VERDICTS.DISPUTED],
  ] as const) {
    const buyer = await setup();
    buyer.scripts.push(settles('Hi.', '1'));
    buyer.state.receiptError = new PaymentError(code);
    const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
    assert.equal(outcome.verdict, verdict, code);
    assert.deepEqual(buyer.calls.receipts, ['1']);
    assert.equal(buyer.recorded[0]?.verdict, verdict);
  }
});
