// The seller's offer set: which offers the catalog lists and the readiness the catalog is bound to. With
// one offer it behaves as that offer did; with several, one offer's state never blocks another. Pure;
// synthetic readiness, no engines or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import { SellerOfferSet } from '@gyblos/node/seller-offer-set';

import { fakeLiveOffer } from './support/seller-offers';

const NOW = 1_000_000;

function setOf(...offers: ReturnType<typeof fakeLiveOffer>[]) {
  const set = new SellerOfferSet(() => NOW);
  for (const offer of offers) set.add(offer.live);
  return set;
}

const shape = (state: QuoteReadiness) => ({
  busy: state.busy,
  observedAt: state.observedAt,
  validUntil: state.validUntil,
});

void test('with one offer the catalog readiness is that offer’s, through generation, renewal and failure', () => {
  const a = fakeLiveOffer(0, NOW);
  const set = setOf(a);
  const states: Partial<QuoteReadiness>[] = [
    {},
    // Generating.
    { busy: true },
    // Renewing: busy with no validity until the check settles.
    { busy: true, validUntil: 0 },
    // Renewed.
    { busy: false, observedAt: NOW, validUntil: NOW + 50_000 },
    // Failed.
    { busy: false, validUntil: 0 },
  ];
  for (const state of states) {
    a.set(state);
    assert.deepEqual(shape(set.readiness()), shape(a.live.readiness()));
  }
});

void test('the catalog generation moves with membership or a new observation, not with generation activity', () => {
  const a = fakeLiveOffer(0, NOW);
  const b = fakeLiveOffer(1, NOW);
  const set = setOf(a, b);
  const first = set.readiness().generation;
  a.set({ busy: true, generation: 7 });
  b.set({ generation: 9 });
  assert.equal(set.readiness().generation, first);
  a.set({ busy: false, observedAt: NOW - 1 });
  const observed = set.readiness().generation;
  assert.notEqual(observed, first);
  b.set({ validUntil: 0 });
  assert.notEqual(set.readiness().generation, observed);
});

void test('an offer that fails leaves the listing and the catalog follows the others', () => {
  const a = fakeLiveOffer(0, NOW);
  const b = fakeLiveOffer(1, NOW, { validUntil: NOW + 30_000 });
  a.set({ validUntil: NOW + 60_000 });
  const set = setOf(a, b);
  assert.deepEqual(
    set.listed().map((offer) => offer.index),
    [0, 1],
  );
  assert.equal(set.readiness().validUntil, NOW + 30_000);
  b.set({ validUntil: 0 });
  assert.deepEqual(
    set.listed().map((offer) => offer.index),
    [0],
  );
  assert.equal(set.readiness().validUntil, NOW + 60_000);
  // Every listed offer gone: nothing to sign.
  a.set({ validUntil: 0 });
  assert.deepEqual(set.listed(), []);
  assert.equal(set.readiness().validUntil, 0);
});

void test('a listed offer stays listed while it renews, but a failed one does not rejoin by renewing', () => {
  const a = fakeLiveOffer(0, NOW);
  const b = fakeLiveOffer(1, NOW);
  const set = setOf(a, b);
  set.listed();
  a.set({ busy: true, validUntil: 0 });
  assert.deepEqual(
    set.listed().map((offer) => offer.index),
    [0, 1],
  );
  // The renewal does not shorten the catalog: B alone bounds it.
  assert.equal(set.readiness().validUntil, b.live.readiness().validUntil);
  a.set({ busy: false });
  assert.deepEqual(
    set.listed().map((offer) => offer.index),
    [1],
  );
  a.set({ busy: true });
  assert.deepEqual(
    set.listed().map((offer) => offer.index),
    [1],
  );
});

void test('the catalog is busy only when every listed offer is busy', () => {
  const a = fakeLiveOffer(0, NOW);
  const b = fakeLiveOffer(1, NOW);
  const set = setOf(a, b);
  a.set({ busy: true });
  assert.equal(set.readiness().busy, false);
  b.set({ busy: true });
  assert.equal(set.readiness().busy, true);
});

void test('offers list in gyblos.toml order and an index or selection is added once', () => {
  const a = fakeLiveOffer(0, NOW);
  const b = fakeLiveOffer(1, NOW);
  const set = new SellerOfferSet(() => NOW);
  set.add(b.live);
  set.add(a.live);
  assert.deepEqual(
    set.listed().map((offer) => offer.index),
    [0, 1],
  );
  assert.throws(() => set.add(fakeLiveOffer(1, NOW, {}, 'other').live));
  assert.throws(() =>
    set.add({ ...fakeLiveOffer(2, NOW).live, selection: a.live.selection }),
  );
});

void test('an offer added later is listed and moves the catalog generation', () => {
  const a = fakeLiveOffer(0, NOW);
  const set = setOf(a);
  const before = set.readiness().generation;
  set.add(fakeLiveOffer(1, NOW).live);
  assert.equal(set.listed().length, 2);
  assert.notEqual(set.readiness().generation, before);
});

void test('the set starts every observation, including later ones, and stops them all', async () => {
  const a = fakeLiveOffer(0, NOW);
  const b = fakeLiveOffer(1, NOW);
  const set = setOf(a);
  const available = async () => undefined;
  set.start(available);
  assert.equal(a.started(), 1);
  set.add(b.live);
  assert.equal(b.started(), 1);
  await set.stop();
  assert.equal(a.stopped(), 1);
  assert.equal(b.stopped(), 1);
  assert.equal(set.readiness().validUntil, 0);
});
