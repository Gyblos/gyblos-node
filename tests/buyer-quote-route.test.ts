// Mixed-price routing uses the same verified winner and permits failover only on a proven-unsent attempt.
import assert from 'node:assert/strict';
import test from 'node:test';

import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import { PAID_BUYER_CODES } from '@gyblos/node/constants';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { setup } from './support/buyer-paid';

async function fixture() {
  const buyer = await setup();
  const paid = buyer.winners[0]!;
  const free = {
    ...buyer.winners[1]!,
    quote: {
      ...buyer.winners[1]!.quote,
      offer: { ...buyer.winners[1]!.quote.offer, inputAtomicPerMtok: '0', outputAtomicPerMtok: '0', maxAtomic: '0' },
    },
  };
  const selected: string[] = [];
  let released = 0;
  let unresolved = false;
  const dependencies = {
    enter: () => () => { released++; },
    unresolved: async () => unresolved,
    select: async (excluded: ReadonlySet<string>) => {
      const winner = [paid, free].find((each) => !excluded.has(each.nodeId));
      assert.ok(winner); selected.push(winner.nodeId); return winner;
    },
    free: async (winner: typeof free) => { assert.equal(winner, free); return 'free answer'; },
    paid: async (winner: typeof paid) => { assert.equal(winner, paid); return 'paid answer'; },
  };
  return { paid, free, dependencies, selected, released: () => released, block: () => { unresolved = true; } };
}
void test('a free signed quote uses no payment port even with a positive buyer ceiling', async () => {
  const f = await fixture();
  f.dependencies.select = async () => f.free;
  f.dependencies.paid = async () => { assert.fail('payment prepared for free quote'); };
  assert.deepEqual(await executeBuyerQuote(f.dependencies), { kind: OFFER_PRICING_KINDS.FREE, result: 'free answer' });
  assert.equal(f.released(), 1);
});
void test('a positive signed quote uses the paid port without selecting another winner', async () => {
  const f = await fixture();
  assert.deepEqual(await executeBuyerQuote(f.dependencies), { kind: OFFER_PRICING_KINDS.PAID, result: 'paid answer' });
  assert.deepEqual(f.selected, [f.paid.nodeId]);
});
void test('a proven-unsent paid attempt may fail over to a free quote', async () => {
  const f = await fixture();
  f.dependencies.paid = async () => undefined;
  assert.equal((await executeBuyerQuote(f.dependencies)).kind, OFFER_PRICING_KINDS.FREE);
  assert.deepEqual(f.selected, [f.paid.nodeId, f.free.nodeId]);
});
void test('a potentially sent failure never selects another seller', async () => {
  const f = await fixture();
  const failure = new Error('synthetic interrupted transport');
  f.dependencies.paid = async () => { throw failure; };
  await assert.rejects(executeBuyerQuote(f.dependencies), failure);
  assert.deepEqual(f.selected, [f.paid.nodeId]);
  assert.equal(f.released(), 1);
});
void test('unresolved signed state blocks even free execution and a failed discard blocks failover', async () => {
  for (const before of [true, false]) {
    const f = await fixture();
    if (before) f.block();
    else f.dependencies.paid = async () => { f.block(); return undefined; };
    f.dependencies.free = async () => { assert.fail('free bypassed unresolved payment'); };
    await assert.rejects(executeBuyerQuote(f.dependencies), { code: PAID_BUYER_CODES.UNRESOLVED });
    assert.equal(f.selected.length, before ? 0 : 1);
  }
});
void test('an inconsistent free price and positive budget is refused without either executor', async () => {
  const f = await fixture();
  f.free.quote.offer.maxAtomic = '1';
  f.dependencies.select = async () => f.free;
  f.dependencies.free = async () => { assert.fail('invalid quote executed'); };
  await assert.rejects(executeBuyerQuote(f.dependencies));
});
