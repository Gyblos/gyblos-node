// Exercises the detached paid execution contract with synthetic signed quotes; never invokes an
// engine, a chain or a payment adapter.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import {
  buildPaidExecutionRequest,
  paidExecutionDigest,
  PaidExecutionError,
  parsePaidExecutionRequest,
  parsePaidExecutionResponse,
  verifyPaidExecutionRequest,
  type PaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';
import type { PaymentAuthorization } from '@gyblos/protocol/payment';

import { controlFixture } from './support/control-fixture';

const CHANNEL = 'c'.repeat(64);

async function fixture() {
  const source = await controlFixture(false);
  const quote = await createControlQuote(
    source.request,
    source.context,
    source.ownerSigner,
  );
  const payment: PaymentAuthorization = {
    channelId: CHANNEL,
    payer: quote.offer.buyer,
    requestDigest: quote.offer.requestDigest,
    maxAtomic: quote.offer.maxAtomic,
    payload: Buffer.from('signed channel open').toString('base64'),
  };
  const request = buildPaidExecutionRequest(
    quote,
    {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Hello' }],
      maxTokens: quote.offer.maxTokens,
    },
    payment,
  );
  const trust = {
    owner: quote.offer.owner,
    nodeId: quote.offer.nodeId,
    remoteNodeId: quote.offer.buyerNodeId,
    now: quote.offer.issuedAt,
  };
  return { source, quote, payment, request, trust };
}

function code(expected: PaidExecutionCode) {
  return (error: unknown) => {
    assert.ok(error instanceof PaidExecutionError, String(error));
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
    return true;
  };
}

void test('a priced quote, its input and the payment authorization form one bound request', async () => {
  const { quote, payment, request, trust } = await fixture();
  assert.ok(BigInt(quote.offer.maxAtomic) > 0n);
  assert.equal(request.version, PAID_EXECUTION.version);
  assert.deepEqual(request.payment, payment);
  assert.deepEqual(await verifyPaidExecutionRequest(request, trust), request);
  const digest = await paidExecutionDigest(request);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(
    await paidExecutionDigest({
      ...request,
      payment: { ...payment, channelId: 'd'.repeat(64) },
    }),
    digest,
  );
});

void test('a free quote is never accepted on the paid channel', async () => {
  const source = await controlFixture(true);
  const free = await createControlQuote(
    source.request,
    source.context,
    source.ownerSigner,
  );
  const { request } = await fixture();
  assert.throws(
    () => parsePaidExecutionRequest({ ...request, quote: free }),
    code(PAID_EXECUTION_CODES.NOT_PAID),
  );
});

void test('the authorization must name the quote request, ceiling and buyer', async () => {
  const { quote, payment, request } = await fixture();
  for (const changed of [
    { requestDigest: 'e'.repeat(64) },
    { maxAtomic: String(BigInt(quote.offer.maxAtomic) - 1n) },
    // A different wallet (the fixture's buyer and payTo coincide).
    { payer: quote.offer.feePayer },
  ])
    assert.throws(
      () =>
        parsePaidExecutionRequest({
          ...request,
          payment: { ...payment, ...changed },
        }),
      code(PAID_EXECUTION_CODES.PAYMENT_MISMATCH),
    );
});

void test('malformed or oversized authorizations are refused before any payment step', async () => {
  const { payment, request } = await fixture();
  for (const [changed, expected] of [
    [{ ...payment, extra: 1 }, PAID_EXECUTION_CODES.INVALID],
    [{ ...payment, payload: 'not base64!' }, PAID_EXECUTION_CODES.INVALID],
    [{ ...payment, channelId: '' }, PAID_EXECUTION_CODES.INVALID],
    [
      { ...payment, payload: 'A'.repeat(PAID_EXECUTION.payloadBytes + 4) },
      PAID_EXECUTION_CODES.LIMIT,
    ],
  ] as const)
    assert.throws(
      () => parsePaidExecutionRequest({ ...request, payment: changed }),
      code(expected),
    );
  const { payment: _payment, ...unpaid } = request;
  assert.throws(
    () => parsePaidExecutionRequest(unpaid),
    code(PAID_EXECUTION_CODES.INVALID),
  );
});

void test('authentication failures keep paid codes', async () => {
  const { request, trust } = await fixture();
  await assert.rejects(
    verifyPaidExecutionRequest(request, {
      ...trust,
      remoteNodeId: 'f'.repeat(64),
    }),
    code(PAID_EXECUTION_CODES.PEER),
  );
  await assert.rejects(
    verifyPaidExecutionRequest(request, {
      ...trust,
      now: request.quote.offer.expiresAt + 1,
    }),
    code(PAID_EXECUTION_CODES.EXPIRED),
  );
});

async function settled(request: PaidExecutionRequest, charged: string) {
  const ceiling = BigInt(request.payment.maxAtomic);
  return {
    settlement: {
      channelId: request.payment.channelId,
      chargedAtomic: charged,
      refundedAtomic: String(ceiling - BigInt(charged)),
      sellerAtomic: '0',
      feeAtomic: '0',
      transaction: 't'.repeat(64),
    },
  };
}

void test('a terminal carries the charge and the settlement or a pending payment', async () => {
  const { request } = await fixture();
  const base = {
    version: PAID_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await paidExecutionDigest(request),
  };
  const result = {
    text: 'Hi',
    usage: { inputTokens: 3, outputTokens: 1 },
    finishReason: ENGINE_DONE_REASONS.STOP,
  };
  const charge = { inputTokens: 3, outputTokens: 1, chargedAtomic: '1' };
  assert.deepEqual(
    parsePaidExecutionResponse({
      ...base,
      result,
      charge,
      payment: await settled(request, '1'),
    }).charge,
    charge,
  );
  const pending = {
    pending: {
      channelId: request.payment.channelId,
      chargedAtomic: '1',
      transaction: null,
    },
  };
  assert.deepEqual(
    parsePaidExecutionResponse({ ...base, result, charge, payment: pending })
      .payment,
    pending,
  );
  // Refused before any deposit: no charge and no payment.
  assert.ok(
    parsePaidExecutionResponse({
      ...base,
      error: { code: PAID_EXECUTION_CODES.PAYMENT_REJECTED },
    }).error,
  );
  // Stopped after deltas: the charge covers what was delivered.
  assert.ok(
    parsePaidExecutionResponse({
      ...base,
      error: {
        code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
        delivered: { outputTokens: 1 },
      },
      charge,
      payment: await settled(request, '1'),
    }).error,
  );
});

void test('terminals whose charge and payment disagree are refused', async () => {
  const { request } = await fixture();
  const base = {
    version: PAID_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await paidExecutionDigest(request),
  };
  const result = {
    text: 'Hi',
    usage: { inputTokens: 3, outputTokens: 1 },
    finishReason: ENGINE_DONE_REASONS.STOP,
  };
  const charge = { inputTokens: 3, outputTokens: 1, chargedAtomic: '1' };
  for (const terminal of [
    { ...base, result },
    { ...base, result, charge },
    { ...base, result, payment: await settled(request, '1') },
    { ...base, result, charge, payment: await settled(request, '2') },
    {
      ...base,
      error: { code: PAID_EXECUTION_CODES.ENGINE },
      charge: { ...charge, outputTokens: 0, chargedAtomic: '1' },
      payment: await settled(request, '1'),
    },
  ])
    assert.throws(
      () => parsePaidExecutionResponse(terminal),
      (error: unknown) => error instanceof PaidExecutionError,
    );
});
