// Verifies acknowledged-prefix billing and incremental UTF-8 bounds after a synthetic deposit.
// Uses only the public seller service and an in-memory payment port; no files or chain.
import assert from 'node:assert/strict';
import test from 'node:test';

import { recountedMeter } from '@gyblos/node/free-meter';
import {
  FREE_EXECUTION,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import {
  PaidExecutionError,
  parsePaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from '@gyblos/protocol/paid/constants';

import { PAID_CEILING, paidSellerFixture } from './support/paid-seller';

void test('a paid delivery limit charges only the acknowledged prefix and refunds the rest', async () => {
  const seller = await paidSellerFixture();
  const paid = await seller.request();
  let deliveries = 0;
  const deltas: string[] = [];
  const terminal = await seller.service.stream(
    paid,
    paid.quote.offer.buyerNodeId,
    new AbortController().signal,
    async (text) => {
      if (++deliveries === 2)
        throw new PaidExecutionError(PAID_EXECUTION_CODES.LIMIT);
      deltas.push(text);
    },
  );
  assert.deepEqual(deltas, ['Hi']);
  assert.deepEqual(parsePaidExecutionResponse(terminal), terminal);
  assert.deepEqual(terminal.error, {
    code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INVALID_RESPONSE,
    delivered: { outputTokens: 2 },
  });
  assert.equal(terminal.charge?.chargedAtomic, '8');
  assert.equal(terminal.payment?.settlement?.refundedAtomic, '12');
  assert.deepEqual(
    seller.payment.calls.settle.map((call) => call.chargedAtomic),
    ['8'],
  );
  assert.equal(seller.engineCalls.length, 1);
});

void test('a paid delivery limit before output and an internal delivery failure never invent usage', async () => {
  for (const code of [
    PAID_EXECUTION_CODES.LIMIT,
    PAID_EXECUTION_CODES.INTERNAL,
  ]) {
    const seller = await paidSellerFixture();
    let deliveries = 0;
    const paid = await seller.request();
    const terminal = await seller.service.stream(
      paid,
      paid.quote.offer.buyerNodeId,
      new AbortController().signal,
      async () => {
        if (code === PAID_EXECUTION_CODES.LIMIT || ++deliveries === 2)
          throw new PaidExecutionError(code);
      },
    );
    assert.equal(terminal.charge?.chargedAtomic, '0');
    assert.deepEqual(parsePaidExecutionResponse(terminal), terminal);
    assert.equal(terminal.error?.delivered, undefined);
    assert.equal(terminal.payment?.settlement?.refundedAtomic, PAID_CEILING);
    assert.equal(seller.payment.calls.settle.length, 1);
  }
});

void test('incremental paid validation bounds total UTF-8 bytes before acknowledging another delta', async () => {
  const seller = await paidSellerFixture({
    meter: recountedMeter({
      input: () => 4,
      chat: () => 4,
      count: (text) => (text ? 1 : 0),
    }),
  });
  const chunk = '€'.repeat(22000);
  seller.setScript({ deltas: Array.from({ length: 4 }, () => chunk) });
  const paid = await seller.request();
  const acknowledged: string[] = [];
  const terminal = await seller.service.stream(
    paid,
    paid.quote.offer.buyerNodeId,
    new AbortController().signal,
    async (text) => {
      acknowledged.push(text);
    },
  );
  assert.equal(acknowledged.join(''), chunk.repeat(3));
  assert.ok(
    new TextEncoder().encode(acknowledged.join('')).length <=
      FREE_EXECUTION.outputBytes,
  );
  assert.equal(
    terminal.error?.code,
    PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  );
  assert.equal(
    terminal.error?.reason,
    FREE_EXECUTION_STOP_REASONS.ENGINE_INVALID_RESPONSE,
  );
  assert.equal(terminal.error?.delivered?.outputTokens, 1);
  assert.equal(terminal.charge?.chargedAtomic, '6');
  assert.equal(terminal.payment?.settlement?.refundedAtomic, '14');
  assert.deepEqual(parsePaidExecutionResponse(terminal), terminal);
  assert.equal(seller.engineCalls.length, 1);
});

void test('an unaffordable whole engine delta is refused before any bounded chunk is delivered', async () => {
  const seller = await paidSellerFixture();
  seller.setScript({ deltas: ['x'.repeat(PAID_STREAM.deltaBytes * 2)] });
  const { terminal, deltas } = await seller.execute(await seller.request());
  assert.deepEqual(deltas, []);
  assert.equal(terminal.error?.code, PAID_EXECUTION_CODES.BUDGET_EXHAUSTED);
  assert.equal(terminal.error?.delivered, undefined);
  assert.equal(terminal.charge?.chargedAtomic, '0');
  assert.equal(terminal.payment?.settlement?.refundedAtomic, PAID_CEILING);
  assert.deepEqual(
    seller.payment.calls.settle.map((call) => call.chargedAtomic),
    ['0'],
  );
  assert.equal(seller.engineCalls.length, 1);
});
