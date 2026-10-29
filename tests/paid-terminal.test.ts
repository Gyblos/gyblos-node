// Pins the paid terminal rules: who is charged for what, after which stops, within which bounds.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import { PaidExecutionError } from '@gyblos/protocol/paid-execution';
import { createPaidStreamVerifier } from '@gyblos/protocol/paid-stream';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import {
  afterDelta,
  refusedWith,
  request,
  settled,
  terminal,
} from './support/paid-fixture';

void test('delivered text always comes with a charge and payment', async () => {
  const paid = await request();
  for (const code of [
    PAID_EXECUTION_CODES.TIMEOUT,
    PAID_EXECUTION_CODES.CANCELLED,
    PAID_EXECUTION_CODES.INTERNAL,
  ])
    await assert.rejects(
      (await afterDelta(paid)).accept(
        await terminal(paid, 1, { error: { code } }),
      ),
      refusedWith(PAID_EXECUTION_CODES.PAYMENT_MISMATCH),
    );
});

void test('budget, timeout and cancel stops charge the delivered output', async () => {
  const paid = await request();
  for (const code of [
    PAID_EXECUTION_CODES.BUDGET_EXHAUSTED,
    PAID_EXECUTION_CODES.TIMEOUT,
    PAID_EXECUTION_CODES.CANCELLED,
  ]) {
    const outcome = await (
      await afterDelta(paid)
    ).accept(
      await terminal(paid, 1, {
        error: { code, delivered: { outputTokens: 1 } },
        charge: { inputTokens: 3, outputTokens: 1, chargedAtomic: '1' },
        payment: settled(paid, '1'),
      }),
    );
    assert.equal(outcome.terminal?.charge?.chargedAtomic, '1', code);
  }
});

void test('refusals before a deposit never carry a charge', async () => {
  const paid = await request();
  const verifier = await createPaidStreamVerifier(paid);
  await assert.rejects(
    verifier.accept(
      await terminal(paid, 0, {
        error: { code: PAID_EXECUTION_CODES.PAYMENT_REJECTED },
        charge: { inputTokens: 3, outputTokens: 0, chargedAtomic: '0' },
        payment: settled(paid, '0'),
      }),
    ),
    PaidExecutionError,
  );
  // A budget stop is always after a deposit, so it always carries a charge.
  await assert.rejects(
    (await createPaidStreamVerifier(paid)).accept(
      await terminal(paid, 0, {
        error: { code: PAID_EXECUTION_CODES.BUDGET_EXHAUSTED },
      }),
    ),
    PaidExecutionError,
  );
});

void test('charged tokens are bounded by delivered bytes and the model context', async () => {
  const paid = await request();
  await assert.rejects(
    (await afterDelta(paid, 'a')).accept(
      await terminal(paid, 1, {
        result: {
          text: 'a',
          usage: { inputTokens: 3, outputTokens: 2 },
          finishReason: ENGINE_DONE_REASONS.STOP,
        },
        charge: { inputTokens: 3, outputTokens: 2, chargedAtomic: '1' },
        payment: settled(paid, '1'),
      }),
    ),
    refusedWith(PAID_EXECUTION_CODES.LIMIT),
  );
  const context = paid.quote.offer.model.contextTokens;
  await assert.rejects(
    (await afterDelta(paid)).accept(
      await terminal(paid, 1, {
        error: {
          code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
          reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
          delivered: { outputTokens: 1 },
        },
        charge: { inputTokens: context, outputTokens: 1, chargedAtomic: '1' },
        payment: settled(paid, '1'),
      }),
    ),
    refusedWith(PAID_EXECUTION_CODES.LIMIT),
  );
});

void test('the settlement shares cover the charge except one unit of rounding dust', async () => {
  const paid = await request();
  const shares = (seller: string, fee: string) => ({
    settlement: {
      ...settled(paid, '5').settlement,
      sellerAtomic: seller,
      feeAtomic: fee,
    },
  });
  const stop = (payment: unknown) =>
    terminal(paid, 1, {
      error: {
        code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
        delivered: { outputTokens: 1 },
      },
      charge: { inputTokens: 3, outputTokens: 1, chargedAtomic: '5' },
      payment,
    });
  assert.ok(
    (await (await afterDelta(paid)).accept(await stop(shares('4', '0'))))
      .terminal,
  );
  assert.ok(
    (await (await afterDelta(paid)).accept(await stop(shares('4', '1'))))
      .terminal,
  );
  for (const [seller, fee] of [
    ['3', '0'],
    ['5', '1'],
  ])
    await assert.rejects(
      (await afterDelta(paid)).accept(await stop(shares(seller!, fee!))),
      refusedWith(PAID_EXECUTION_CODES.PAYMENT_MISMATCH),
    );
});
