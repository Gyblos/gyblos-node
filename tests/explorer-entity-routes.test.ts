import assert from 'node:assert/strict';
import test from 'node:test';

import { addressHref } from '@gyblos/explorer/config';
import {
  addressLookup,
  modelMatches,
  searchPageHref,
  sellerMatches,
} from '@gyblos/explorer/entity-search';
import { modelFromSlug, modelHref } from '@gyblos/explorer/offers';
import {
  directoryHref,
  numberedPager,
  pageOf,
  rangeOf,
  readQuery,
} from '@gyblos/explorer/paging';
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

void test('search page links retain the query including literal punctuation across pages', () => {
  const view = numberedPager(pageOf([1, 2, 3, 4, 5, 6], 1), (page) =>
    searchPageHref('A + B/1', page),
  );
  assert.equal(view.rows, 'Rows 1–5 of 6');
  const next = new URL(view.hrefs[2]!, 'https://explorer.example');
  assert.equal(next.pathname, '/search');
  assert.equal(next.searchParams.get('q'), 'A + B/1');
  assert.equal(next.searchParams.get('page'), '2');
  assert.equal(new URL(view.hrefs[1]!, next).searchParams.has('page'), false);
});

void test('address lookup accepts canonical Solana keys even outside the latest transactions', () => {
  const wallet = 'CQ3znZDWsSH6unNaov2aizowCueQPFozRUyRrMuyuJde';
  assert.equal(addressLookup(wallet), wallet);
  assert.equal(addressLookup('1'.repeat(32)), '1'.repeat(32));
  assert.equal(addressLookup('1'.repeat(44)), null);
  assert.equal(addressLookup('CQ3z…uJde'), null);
});

void test('seller search matches the verified account, public name, node and case-sensitive wallet', () => {
  const account = { account: 'gyro', gist: 'proof' };
  const seller = {
    nodeId: 'c'.repeat(64),
    owner: 'CQ3znZDWsSH6unNaov2aizowCueQPFozRUyRrMuyuJde',
    github: account,
    name: 'Local lab',
  };
  for (const term of ['@Gyro', 'LOCAL LAB', 'ccc', 'CQ3z']) {
    assert.ok(sellerMatches(seller, term), term);
  }
  assert.equal(sellerMatches(seller, 'cq3z'), false);
  assert.equal(sellerMatches(seller, '@'), false);
});

void test('entity directory links retain the viewed activity window and discard detail pagination', () => {
  for (const path of ['/models', '/sellers'] as const) {
    const detail = readQuery(
      { closed: '1', modelsRange: '7', modelsPage: '2' },
      '/models/example',
    );
    const target = new URL(
      directoryHref(path, detail, 'models'),
      'https://explorer.example',
    );
    assert.equal(target.pathname, path);
    assert.equal(target.searchParams.has('modelsPage'), false);
    const list = readQuery(target.searchParams, path);
    assert.equal(list.closed, true);
    assert.equal(list.days, 7);
  }
});

void test('a model matches its id, known lab, variant or quantization, never a fallback lab', () => {
  const model = (modelId: string) => ({
    modelId,
    variant: 'base',
    quantization: 'q4',
  });
  assert.equal(modelMatches(model('qwen3-0.6b'), 'alibaba'), true);
  assert.equal(modelMatches(model('qwen3-0.6b'), 'Q4'), true);
  assert.equal(modelMatches(model('mystery-7b'), 'known'), false);
  assert.equal(modelMatches(model('mystery-7b'), 'other'), false);
});
