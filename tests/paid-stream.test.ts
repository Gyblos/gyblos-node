// Exercises the paid stream verifier with synthetic events; no transport, engine or chain.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_EXECUTION_STOP_REASONS } from '@gyblos/protocol/constants';
import {
  paidExecutionDigest,
  PaidExecutionError,
} from '@gyblos/protocol/paid-execution';
import {
  createPaidStreamVerifier,
  decodePaidStreamEvent,
  encodePaidStreamEvent,
} from '@gyblos/protocol/paid-stream';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from '@gyblos/protocol/paid/constants';

import {
  CHARGE,
  header,
  request,
  RESULT,
  settled,
} from './support/paid-fixture';

void test('deltas then a settled terminal yield the result, charge and settlement', async () => {
  const paid = await request();
  const verifier = await createPaidStreamVerifier(paid);
  assert.deepEqual(
    await verifier.accept({
      ...(await header(paid, 0)),
      type: 'delta',
      text: 'Hi',
    }),
    { delta: 'Hi' },
  );
  await verifier.accept({
    ...(await header(paid, 1)),
    type: 'delta',
    text: '.',
  });
  const terminal = {
    ...(await header(paid, 2)),
    type: 'terminal',
    response: {
      version: PAID_EXECUTION.version,
      requestId: paid.requestId,
      requestDigest: await paidExecutionDigest(paid),
      result: RESULT,
      charge: CHARGE,
      payment: settled(paid, '1'),
    },
  };
  const outcome = await verifier.accept(terminal);
  assert.deepEqual(outcome.terminal?.result, RESULT);
  assert.deepEqual(outcome.terminal?.charge, CHARGE);
  verifier.finish();
  assert.deepEqual(
    decodePaidStreamEvent(encodePaidStreamEvent(terminal)),
    terminal,
  );
  assert.equal(PAID_STREAM.events.TERMINAL, 'terminal');
});

void test('a stream that delivered nothing can only charge zero', async () => {
  const paid = await request();
  const base = {
    version: PAID_EXECUTION.version,
    requestId: paid.requestId,
    requestDigest: await paidExecutionDigest(paid),
    error: { code: PAID_EXECUTION_CODES.ENGINE },
  };
  const zero = await createPaidStreamVerifier(paid);
  const outcome = await zero.accept({
    ...(await header(paid, 0)),
    type: 'terminal',
    response: {
      ...base,
      charge: { inputTokens: 3, outputTokens: 0, chargedAtomic: '0' },
      payment: settled(paid, '0'),
    },
  });
  assert.equal(outcome.terminal?.charge?.chargedAtomic, '0');
  const charged = await createPaidStreamVerifier(paid);
  await assert.rejects(
    charged.accept({
      ...(await header(paid, 0)),
      type: 'terminal',
      response: {
        ...base,
        charge: { inputTokens: 3, outputTokens: 0, chargedAtomic: '1' },
        payment: settled(paid, '1'),
      },
    }),
    PaidExecutionError,
  );
});

void test('a completed result with no delivered text can only charge zero', async () => {
  const paid = await request();
  const verifier = await createPaidStreamVerifier(paid);
  await assert.rejects(
    verifier.accept({
      ...(await header(paid, 0)),
      type: 'terminal',
      response: {
        version: PAID_EXECUTION.version,
        requestId: paid.requestId,
        requestDigest: await paidExecutionDigest(paid),
        result: {
          ...RESULT,
          text: '',
          usage: { inputTokens: 3, outputTokens: 0 },
        },
        charge: { inputTokens: 3, outputTokens: 0, chargedAtomic: '1' },
        payment: settled(paid, '1'),
      },
    }),
    (error: unknown) =>
      error instanceof PaidExecutionError &&
      error.code === PAID_EXECUTION_CODES.PAYMENT_MISMATCH,
  );
});

void test('a partial stop charges the delivered output and binds to the deposited channel', async () => {
  const paid = await request();
  const response = async (payment: unknown) => ({
    ...(await header(paid, 1)),
    type: 'terminal',
    response: {
      version: PAID_EXECUTION.version,
      requestId: paid.requestId,
      requestDigest: await paidExecutionDigest(paid),
      error: {
        code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
        delivered: { outputTokens: 1 },
      },
      charge: { inputTokens: 3, outputTokens: 1, chargedAtomic: '1' },
      payment,
    },
  });
  const accepted = await createPaidStreamVerifier(paid);
  await accepted.accept({
    ...(await header(paid, 0)),
    type: 'delta',
    text: 'Hi',
  });
  assert.equal(
    (await accepted.accept(await response(settled(paid, '1')))).terminal?.error
      ?.code,
    PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
  );
  const ceiling = BigInt(paid.payment.maxAtomic);
  for (const payment of [
    {
      settlement: {
        ...settled(paid, '1').settlement,
        channelId: 'd'.repeat(64),
      },
    },
    { settlement: { ...settled(paid, '1').settlement, refundedAtomic: '0' } },
    {
      pending: {
        channelId: 'd'.repeat(64),
        chargedAtomic: '1',
        transaction: null,
      },
    },
  ]) {
    const verifier = await createPaidStreamVerifier(paid);
    await verifier.accept({
      ...(await header(paid, 0)),
      type: 'delta',
      text: 'Hi',
    });
    await assert.rejects(
      verifier.accept(await response(payment)),
      (error: unknown) =>
        error instanceof PaidExecutionError &&
        error.code === PAID_EXECUTION_CODES.PAYMENT_MISMATCH,
    );
  }
  assert.ok(ceiling > 1n);
});

void test('a charge above the deposited ceiling is refused', async () => {
  const paid = await request();
  const over = String(BigInt(paid.payment.maxAtomic) + 1n);
  const verifier = await createPaidStreamVerifier(paid);
  await verifier.accept({
    ...(await header(paid, 0)),
    type: 'delta',
    text: 'Hi.',
  });
  await assert.rejects(
    verifier.accept({
      ...(await header(paid, 1)),
      type: 'terminal',
      response: {
        version: PAID_EXECUTION.version,
        requestId: paid.requestId,
        requestDigest: await paidExecutionDigest(paid),
        result: RESULT,
        charge: { ...CHARGE, chargedAtomic: over },
        payment: {
          pending: {
            channelId: paid.payment.channelId,
            chargedAtomic: over,
            transaction: null,
          },
        },
      },
    }),
    (error: unknown) =>
      error instanceof PaidExecutionError &&
      error.code === PAID_EXECUTION_CODES.LIMIT,
  );
});

void test('out-of-order or foreign events fail the stream', async () => {
  const paid = await request();
  const verifier = await createPaidStreamVerifier(paid);
  await assert.rejects(
    verifier.accept({ ...(await header(paid, 1)), type: 'delta', text: 'Hi' }),
    (error: unknown) =>
      error instanceof PaidExecutionError &&
      error.code === PAID_EXECUTION_CODES.BINDING,
  );
  assert.throws(() => verifier.finish(), PaidExecutionError);
});
