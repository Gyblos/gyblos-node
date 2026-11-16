// Protects exact historical quote references, canonical bytes and caller-owned snapshots.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { CONTROL_CODES, CONTROL_DOMAINS } from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import { offerDigestV2 } from '@gyblos/protocol/offer-v2';
import { buildReceiptUploadOfferV2 } from '@gyblos/protocol/receipt-upload-v2';
import { signingBytes } from '@gyblos/protocol/signing';

import { clone, rejects } from './support/receipt-upload';
import { quoteRecord } from './support/receipt-upload-v2';

void test('quote reference hashes the complete canonical offer signing bytes without a clock', async () => {
  const offer = await quoteRecord();
  const expected = createHash('sha256')
    .update(signingBytes(CONTROL_DOMAINS.OFFER, offer))
    .digest('hex');
  assert.equal(await offerDigestV2(offer), expected);
  const reordered = Object.fromEntries(Object.entries(offer).reverse());
  assert.equal(await offerDigestV2(reordered), expected);
});

void test('quotes sharing the six upload facts remain distinguishable', async () => {
  const offer = await quoteRecord();
  const digest = await offerDigestV2(offer);
  const changes: ((value: InferenceOfferV2) => void)[] = [
    (value) => (value.requestId = 'ab'.repeat(16)),
    (value) => (value.requestDigest = 'cd'.repeat(32)),
    (value) => (value.prices.inputAtomicPerMtok = '3'),
    (value) => (value.endpoint.relayUrl = 'https://other.example'),
    (value) => (value.model.contextTokens += 1),
    (value) => (value.capabilities.logprobs = !value.capabilities.logprobs),
  ];
  for (const change of changes) {
    const different = clone(offer);
    change(different);
    assert.notEqual(await offerDigestV2(different), digest);
  }
});

void test('quote reference snapshots nested fields before asynchronous hashing', async () => {
  const offer = await quoteRecord();
  const expected = createHash('sha256')
    .update(signingBytes(CONTROL_DOMAINS.OFFER, offer))
    .digest('hex');
  const pending = offerDigestV2(offer);
  offer.endpoint.relayUrl = 'https://changed.example';
  offer.prices.outputAtomicPerMtok = '999';
  assert.equal(await pending, expected);
});

void test('quote reference rejects unknown fields and accessors without invoking them', async () => {
  const offer = await quoteRecord();
  await rejects(
    offerDigestV2({ ...offer, extra: null }),
    CONTROL_CODES.INVALID,
  );
  let reads = 0;
  Object.defineProperty(offer, 'owner', {
    enumerable: true,
    get() {
      reads++;
      return '';
    },
  });
  await rejects(offerDigestV2(offer), CONTROL_CODES.INVALID);
  assert.equal(reads, 0);
});

void test('upload offer builder keeps only six facts and the reference from one snapshot', async () => {
  const offer = await quoteRecord();
  const original = clone(offer);
  const pending = buildReceiptUploadOfferV2(offer);
  offer.issuedAt += 1;
  offer.availability.observedAt += 1;
  const facts = await pending;
  assert.deepEqual(facts, {
    issuedAt: original.issuedAt,
    expiresAt: original.expiresAt,
    maxAtomic: original.maxAtomic,
    maxTokens: original.maxTokens,
    observedAt: original.availability.observedAt,
    catalogDigest: original.catalogDigest,
    offerDigest: await offerDigestV2(original),
  });
  assert.equal(
    JSON.stringify(facts).includes(original.endpoint.relayUrl!),
    false,
  );
  assert.equal(Object.hasOwn(facts, 'endpoint'), false);
  const invalid = clone(original);
  invalid.expiresAt = invalid.issuedAt - 1;
  await rejects(buildReceiptUploadOfferV2(invalid), CONTROL_CODES.INVALID);
});
