import assert from 'node:assert/strict';
import test from 'node:test';

import { addressHref } from '@gyblos/explorer/config';
import { modelFromSlug, modelHref } from '@gyblos/explorer/offers';
import { rangeOf, readQuery } from '@gyblos/explorer/paging';
import { sellerFace, sellerHref } from '@gyblos/explorer/seller-identity';
import { pagePath } from '@gyblos/explorer/seller-page';

void test('model links preserve namespace, variant, quantization and range through navigation', () => {
  const model = { modelId: 'lab/éclair', variant: null, quantization: 'Q4/K' };
  const url = new URL(modelHref(model, 7), 'https://explorer.example');
  assert.equal(url.searchParams.get('range'), '7');
  assert.deepEqual(modelFromSlug(url.pathname.split('/')[2]!), model);
  assert.equal(pagePath(url.pathname), url.pathname);
  assert.notEqual(
    modelHref(model),
    modelHref({ ...model, variant: 'instruct' }),
  );
  assert.equal(modelFromSlug('not-a-model'), null);
});

void test('address links keep users inside the Explorer', () => {
  assert.equal(addressHref('abc'), '/addresses/abc');
});

void test('a seller keeps its face across lists and profile views', () => {
  const node = 'a'.repeat(64);
  assert.deepEqual(sellerFace(node), sellerFace(node));
  assert.notDeepEqual(sellerFace(node), sellerFace('b'.repeat(64)));
});

void test('a completed-day model drilldown keeps the same window on seller profiles', () => {
  const url = new URL(
    modelHref({ modelId: 'tiny', variant: null, quantization: null }, 7, true),
    'https://explorer.example',
  );
  const query = readQuery(url.searchParams, url.pathname);
  assert.equal(query.closed, true);
  assert.equal(rangeOf(query, 'models'), 7);
  const sellerUrl = new URL(sellerHref('a'.repeat(64), query), url);
  const seller = readQuery(sellerUrl.searchParams, sellerUrl.pathname);
  assert.equal(seller.closed, true);
  assert.equal(rangeOf(seller, 'activity'), 7);
});
