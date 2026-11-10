// Reusable sessions approve only independently verified usage and preserve immutable autonomous closure.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

import { createBatchBuyer } from '@gyblos/payments-upto/batch-session';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

void test('several metered requests share one zero-charge deposit and one final seller close', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  assert.equal(rig.buyer.snapshot().cumulativeAtomic, '0');
  await rig.serve(1, '40');
  await rig.serve(2, '60');
  await rig.serve(3, '45');
  assert.deepEqual(rig.calls, ['deposit']);
  const settlement = await rig.seller().close();
  assert.equal(settlement.chargedAtomic, '145');
  assert.equal(settlement.refundedAtomic, '855');
  assert.deepEqual(rig.calls, ['deposit', 'refund']);
  assert.deepEqual(await rig.seller().close(), settlement);
  assert.equal(rig.calls.length, 2);
});
void test('buyer refuses a reported amount that differs from its own usage count', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await assert.rejects(rig.serve(1, '45', '44'), {
    code: SESSION_CODES.UNVERIFIED,
  });
  assert.equal(rig.buyer.snapshot().cumulativeAtomic, '0');
  assert.equal((await rig.seller().close()).chargedAtomic, '0');
});
void test('lost final buyer approval charges only the previously accepted total', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '40');
  const request = rig.request(2);
  await rig.seller().reserve(request, rig.terms.buyerNodeId);
  await rig.seller().finish(request.requestId, '45');
  rig.time(rig.now() + 1001);
  const closed = await rig.seller().tick();
  assert.equal(closed?.chargedAtomic, '40');
  assert.equal(closed.refundedAtomic, '960');
});
void test('restart restores the highest voucher and seller closes without the buyer', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '145');
  await rig.restart();
  rig.time(rig.now() + 1001);
  assert.equal((await rig.seller().tick())?.chargedAtomic, '145');
  assert.deepEqual(rig.calls, ['deposit', 'refund']);
});
void test('soft minimum defers idle dust but expiry still refunds it', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '1');
  rig.time(rig.now() + 1001);
  assert.equal(await rig.seller().tick(), undefined);
  rig.time(rig.terms.expiresAt);
  assert.equal((await rig.seller().tick())?.chargedAtomic, '1');
});
void test('buyer-forced closing bypasses the idle threshold', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '1');
  rig.closing(true);
  assert.equal((await rig.seller().tick())?.chargedAtomic, '1');
});
void test('unknown settlement retains closing and blocks new reservations across restart', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '145');
  rig.confirmed(false);
  await assert.rejects(rig.seller().close(), {
    code: SESSION_CODES.UNVERIFIED,
  });
  await rig.restart();
  await assert.rejects(
    rig.seller().reserve(rig.request(2), rig.terms.buyerNodeId),
    { code: SESSION_CODES.CLOSED },
  );
  rig.confirmed(true);
  assert.equal((await rig.seller().close()).chargedAtomic, '145');
});
void test('same request cannot be reserved twice and a second active reservation is refused', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.seller().reserve(rig.request(1), rig.terms.buyerNodeId);
  await assert.rejects(
    rig.seller().reserve(rig.request(1), rig.terms.buyerNodeId),
    { code: SESSION_CODES.BINDING },
  );
  await assert.rejects(
    rig.seller().reserve(rig.request(2), rig.terms.buyerNodeId),
    { code: SESSION_CODES.BUSY },
  );
});
void test('wrong authenticated buyer and altered voucher never advance the total', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await assert.rejects(rig.seller().reserve(rig.request(1), 'ff'.repeat(32)), {
    code: SESSION_CODES.BINDING,
  });
  const request = rig.request(1);
  await rig.buyer.begin(request);
  await rig.seller().reserve(request, rig.terms.buyerNodeId);
  const bill = await rig.seller().finish(request.requestId, '145');
  const voucher = await rig.buyer.approve(bill, '145');
  await assert.rejects(
    rig
      .seller()
      .accept(
        bill,
        { ...voucher, signature: '1'.repeat(88) },
        rig.terms.buyerNodeId,
      ),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(rig.seller().snapshot().cumulativeAtomic, '0');
});
void test('unacknowledged signature is recoverable and never permits another prompt', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const request = rig.request(1);
  await rig.buyer.begin(request);
  await rig.seller().reserve(request, rig.terms.buyerNodeId);
  const bill = await rig.seller().finish(request.requestId, '145');
  const voucher = await rig.buyer.approve(bill, '145');
  await assert.rejects(rig.buyer.begin(rig.request(2)), {
    code: SESSION_CODES.BUSY,
  });
  assert.deepEqual(await rig.buyer.recoverApproval(), { bill, voucher });
  await rig.seller().accept(bill, voucher, rig.terms.buyerNodeId);
  await rig.seller().accept(bill, voucher, rig.terms.buyerNodeId);
  assert.equal(rig.seller().snapshot().cumulativeAtomic, '145');
});
void test('deposit exhaustion closes once without topping up', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const request = rig.request(1, '1000');
  await rig.buyer.begin(request);
  await rig.seller().reserve(request, rig.terms.buyerNodeId);
  const bill = await rig.seller().finish(request.requestId, '1000');
  const voucher = await rig.buyer.approve(bill, '1000');
  await rig.seller().accept(bill, voucher, rig.terms.buyerNodeId);
  assert.equal((await rig.seller().tick())?.refundedAtomic, '0');
  assert.deepEqual(rig.calls, ['deposit', 'refund']);
});
void test('private bounded journals preserve the same opening and contain no request content', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const opening = await rig.buyer.open();
  assert.equal(await rig.buyer.open(), opening);
  const paths = rig.buyerOptions.paths;
  assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.terms.depositAtomic, '1000');
  await assert.rejects(createBatchBuyer(rig.buyerOptions));
  assert.equal(rig.buyer.snapshot().state, SESSION_STATES.OPEN);
});

void test('an uncertain approval cannot authorize the same request twice with a higher total', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const request = rig.request(1);
  await rig.buyer.begin(request);
  await rig.seller().reserve(request, rig.terms.buyerNodeId);
  const bill = await rig.seller().finish(request.requestId, '145');
  await rig.buyer.approve(bill, '145');
  await assert.rejects(
    rig.buyer.approve({ ...bill, cumulativeAtomic: '290' }, '145'),
    { code: SESSION_CODES.BINDING },
  );
  assert.equal(rig.buyer.snapshot().cumulativeAtomic, '145');
});

void test('seller worker closes autonomously while the buyer is offline', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '145');
  t.mock.timers.enable({ apis: ['setInterval'] });
  rig.sellerOptions.pollMs = 5;
  await rig.restart();
  await rig.buyer.dispose();
  rig.time(rig.now() + 1001);
  t.mock.timers.tick(5);
  // Disposal drains the task scheduled by the timer; it never performs financial closure itself.
  await rig.seller().dispose();
  assert.equal(rig.seller().snapshot().state, SESSION_STATES.CLOSED);
  assert.deepEqual(rig.calls, ['deposit', 'refund']);
});

void test('a slow deposit is bounded and cannot admit inference after timing out', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  rig.sellerOptions.operationMs = 20;
  rig.sellerOptions.facilitator = async () => ({
    verify: async () => ({ isValid: true, payer: rig.terms.buyer }),
    settle: async () => new Promise(() => {}),
  });
  await rig.restart();
  await assert.rejects(rig.open(), { code: SESSION_CODES.UNAVAILABLE });
  await assert.rejects(
    rig.seller().reserve(rig.request(1), rig.terms.buyerNodeId),
    { code: SESSION_CODES.CLOSED },
  );
  assert.equal(rig.seller().snapshot().state, SESSION_STATES.OPENING);
});
void test('expired host terms refuse the initial opening before any deposit', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  rig.time(rig.terms.expiresAt);
  await assert.rejects(rig.open(), { code: SESSION_CODES.CLOSED });
  assert.deepEqual(rig.calls, []);
});
void test('buyer records a verified final refund without opening a replacement channel', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '145');
  const settled = await rig.seller().close();
  await rig.buyer.reconcile(async () => settled);
  assert.equal(rig.buyer.snapshot().state, SESSION_STATES.CLOSED);
  await assert.rejects(rig.buyer.open(), { code: SESSION_CODES.CLOSED });
  assert.deepEqual(rig.calls, ['deposit', 'refund']);
});

void test('returned vouchers and bills cannot mutate the live durable session', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const request = rig.request(1);
  await rig.buyer.begin(request);
  await rig.seller().reserve(request, rig.terms.buyerNodeId);
  const bill = await rig.seller().finish(request.requestId, '145');
  const original = structuredClone(bill);
  bill.requestDigest = 'ff'.repeat(32);
  const voucher = await rig.buyer.approve(original, '145');
  const expected = structuredClone(voucher);
  voucher.signature = '1'.repeat(88);
  assert.deepEqual((await rig.buyer.recoverApproval())?.voucher, expected);
  await rig.seller().accept(original, expected, rig.terms.buyerNodeId);
});
void test('forced close switches an existing unconfirmed refund into seal immediately', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '145');
  rig.confirmed(false);
  await assert.rejects(rig.seller().close());
  rig.closing(true);
  await assert.rejects(rig.seller().close());
  assert.deepEqual(rig.calls, ['deposit', 'refund', 'seal']);
});
void test('signed but unacknowledged usage is not reserved a second time', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const request = rig.request(1, '1000');
  await rig.buyer.begin(request);
  await rig.seller().reserve(request, rig.terms.buyerNodeId);
  const bill = await rig.seller().finish(request.requestId, '1000');
  await rig.buyer.approve(bill, '1000');
  const snapshot = rig.buyer.snapshot();
  assert.ok(
    BigInt(snapshot.cumulativeAtomic) + BigInt(snapshot.reservedAtomic) <=
      1000n,
  );
});
void test('record exhaustion does not close the last active inference', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  for (let index = 1; index < 128; index++) await rig.serve(index, '0');
  await rig.seller().reserve(rig.request(128), rig.terms.buyerNodeId);
  assert.equal(await rig.seller().tick(), undefined);
  assert.equal(
    (await rig.seller().finish(rig.request(128).requestId, '1')).chargedAtomic,
    '1',
  );
});
