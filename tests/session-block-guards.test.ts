// Durable financial guards reject conflicting checkpoints and cancellation without releasing an inference early.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';

import { chargeV2 } from '@gyblos/core/pricing-v2';
import {
  PaymentSessionError,
  SESSION_CODES,
  type SessionCode,
} from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';
import { blockJson } from './support/block-json';
import { blockIntent } from './support/session-block-intent';

async function fixture(t: TestContext) {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  const request = f.request(1);
  await f.buyer.beginBlocks(request);
  await f.seller().reserveBlocks(request, f.terms.buyerNodeId);
  return { ...f, current: request, first: blockIntent(request, 0, '10') };
}
const code = (expected: SessionCode) => (error: unknown) =>
  error instanceof PaymentSessionError && error.code === expected;

void test('neither a different verified amount nor unknown content fields can reach signing', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.buyer.approveBlock(f.first, '11'),
    code(SESSION_CODES.UNVERIFIED),
  );
  const content = { ...f.first, text: 'synthetic-forbidden-field' };
  await assert.rejects(
    f.buyer.approveBlock(content, '10'),
    code(SESSION_CODES.INVALID),
  );
  assert.equal(await f.buyer.recoverBlockApproval(), undefined);
  assert.equal(f.buyer.snapshot().cumulativeAtomic, '0');
});
void test('the seller verifies peer and native signature before durably acknowledging', async (t) => {
  const f = await fixture(t);
  await f.seller().checkpoint(f.first);
  const voucher = await f.buyer.approveBlock(f.first, '10');
  await assert.rejects(
    f.seller().acceptBlock(f.first, voucher, '33'.repeat(32)),
    code(SESSION_CODES.BINDING),
  );
  await assert.rejects(
    f
      .seller()
      .acceptBlock(
        f.first,
        { ...voucher, signature: '1'.repeat(64) },
        f.terms.buyerNodeId,
      ),
    code(SESSION_CODES.UNVERIFIED),
  );
  assert.equal(f.seller().snapshot().cumulativeAtomic, '0');
  await f.seller().acceptBlock(f.first, voucher, f.terms.buyerNodeId);
  assert.equal(f.seller().snapshot().cumulativeAtomic, '10');
});
for (const changed of ['index', 'digest', 'input', 'amount']) {
  void test(`a pending checkpoint cannot be replaced by changed ${changed}`, async (t) => {
    const f = await fixture(t);
    await f.seller().checkpoint(f.first);
    const other = {
      ...f.first,
      ...(changed === 'index' ? { index: 1 } : {}),
      ...(changed === 'digest' ? { digest: '33'.repeat(32) } : {}),
      ...(changed === 'input'
        ? { usage: { ...f.first.usage, inputTokens: 3 } }
        : {}),
      ...(changed === 'amount'
        ? {
            bill: {
              ...f.first.bill,
              chargedAtomic: '11',
              cumulativeAtomic: '11',
            },
          }
        : {}),
    };
    await assert.rejects(
      f.seller().checkpoint(other),
      code(SESSION_CODES.BINDING),
    );
    assert.equal(f.seller().snapshot().cumulativeAtomic, '0');
    assert.equal(f.seller().snapshot().reservedAtomic, '200');
  });
}
void test('legacy finish and approval cannot bypass the block reservation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.seller().finish(f.current.requestId, '10'),
    code(SESSION_CODES.BINDING),
  );
  await assert.rejects(
    f.buyer.approve(f.first.bill, '10'),
    code(SESSION_CODES.BINDING),
  );
  await assert.rejects(
    f.buyer.acknowledge(f.current.requestId),
    code(SESSION_CODES.BINDING),
  );
  assert.equal(f.buyer.snapshot().reservedAtomic, '200');
});
void test('cancellation before intent creates no signature or recoverable approval', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.buyer.approveBlock(f.first, '10', () => {
      throw new Error('synthetic cancellation');
    }),
  );
  assert.equal(await f.buyer.recoverBlockApproval(), undefined);
  assert.equal(f.buyer.snapshot().reservedAtomic, '200');
});
void test('cancellation after signing preserves the exact voucher for financial recovery', async (t) => {
  const f = await fixture(t);
  let checks = 0;
  await assert.rejects(
    f.buyer.approveBlock(f.first, '10', () => {
      if (++checks === 3) throw new Error('synthetic cancellation');
    }),
  );
  assert.equal(f.buyer.snapshot().cumulativeAtomic, '10');
  assert.equal(f.buyer.snapshot().reservedAtomic, '190');
  const recovered = await f.buyer.recoverBlockApproval();
  assert.ok(recovered);
  assert.deepEqual(recovered.intent, f.first);
  assert.equal(
    (await f.buyer.approveBlock(f.first, '10')).signature,
    recovered.voucher.signature,
  );
});
void test('cumulative rounding does not charge one new atomic minimum for each block', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) {
    const amount = String(
      chargeV2(
        { input: 2, output: index + 1 },
        { inputAtomicPerMtok: '1', outputAtomicPerMtok: '1' },
      ),
    );
    assert.equal(amount, '1');
    const intent = blockIntent(f.current, index, amount, index === 2);
    await f.seller().checkpoint(intent);
    const voucher = await f.buyer.approveBlock(intent, amount);
    await f.seller().acceptBlock(intent, voucher, f.terms.buyerNodeId);
    await f.buyer.acknowledgeBlock(intent);
  }
  assert.equal(f.buyer.snapshot().cumulativeAtomic, '1');
  assert.equal((await f.seller().close()).refundedAtomic, '999');
});
void test('a legacy unresolved inference prevents a block-format upgrade', async (t) => {
  const f = await sessionRig();
  t.after(f.dispose);
  await f.open();
  await f.buyer.begin(f.request(1));
  await assert.rejects(
    f.buyer.beginBlocks(f.request(2)),
    code(SESSION_CODES.BUSY),
  );
  const record = blockJson(
    JSON.parse(await readFile(f.buyerOptions.paths.state, 'utf8')),
  );
  assert.equal(record.version, 1);
  assert.equal(Object.hasOwn(record, 'blocks'), false);
});
