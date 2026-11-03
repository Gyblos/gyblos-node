// Checks the shared clock-skew tolerance on v2 public records, quotes and seller selection: a record
// issued slightly ahead of the verifier's clock is accepted, one beyond the tolerance is refused, and
// expiry stays exact. Synthetic timestamps only; no signer, transport or payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { selectSellers } from '@gyblos/core/seller-selection';
import { CONTROL_CODES, CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import { validatePublicV2Time } from '@gyblos/protocol/public-v2';

import {
  NOW,
  request,
  seeded,
  seller,
} from './support/seller-selection-fixture';

const now = NOW;
const skew = CONTROL_LIMITS.clockSkewMs;

type PublicRecord = Parameters<typeof validatePublicV2Time>[0];
type Offer = Parameters<typeof validateOfferV2Time>[0];
const presence = (issuedAt: number, expiresAt = issuedAt + 60_000) =>
  ({ kind: 'presence', issuedAt, expiresAt }) as PublicRecord;
const offer = (issuedAt: number, expiresAt = issuedAt + 20_000) =>
  ({ issuedAt, expiresAt, availability: { observedAt: issuedAt } }) as Offer;
const expired = { code: CONTROL_CODES.EXPIRED };

void test('the tolerance is a few seconds, not a lifetime', () => {
  assert.ok(skew > 0 && skew <= 5_000);
});

void test('a public record issued within the tolerance ahead of the verifier is accepted', () => {
  validatePublicV2Time(presence(now + 230), now);
  validatePublicV2Time(presence(now + skew), now);
  assert.throws(
    () => validatePublicV2Time(presence(now + skew + 1), now),
    expired,
  );
});

void test('a quote issued within the tolerance ahead of the buyer is accepted', () => {
  validateOfferV2Time(offer(now + 230), now);
  validateOfferV2Time(offer(now + skew), now);
  assert.throws(() => validateOfferV2Time(offer(now + skew + 1), now), expired);
});

void test('expiry gets no grace', () => {
  assert.throws(
    () => validatePublicV2Time(presence(now - 60_000, now), now),
    expired,
  );
  assert.throws(
    () => validateOfferV2Time(offer(now - 20_000, now), now),
    expired,
  );
  validatePublicV2Time(presence(now - 59_999, now + 1), now);
});

void test('selection keeps a seller whose fresh presence is slightly ahead of the buyer clock', () => {
  const ahead = (offset: number) => {
    const known = seller(1);
    // Signed by the seller an instant ago, on a clock `offset` ms ahead of the buyer's.
    known.presence = { ...known.presence!, issuedAt: NOW + offset };
    return selectSellers({
      request: request(),
      sellers: [known],
      stats: new Map(),
      now: NOW,
      random: seeded(1),
    });
  };
  assert.equal(ahead(230).ok, true);
  assert.equal(ahead(skew).ok, true);
  assert.deepEqual(ahead(skew + 1), {
    ok: false,
    code: SELLER_SELECTION_CODES.NO_CANDIDATES,
  });
});
