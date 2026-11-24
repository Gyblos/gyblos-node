import assert from 'node:assert/strict';
import test from 'node:test';

import { DISPLAY, NODE_STATE } from '@gyblos/explorer/constants';
import { hashTarget } from '@gyblos/explorer/hash-target';
import { NODE_STATES } from '@gyblos/explorer/network-status';
import { readQuery } from '@gyblos/explorer/paging';
import { sellerHref } from '@gyblos/explorer/seller-identity';
import { modelsNote, modelsServedText } from '@gyblos/explorer/seller-profile';
import { AGGREGATES } from '@gyblos/metrics-collector/constants';

const NODE = 'a'.repeat(64);
const CURSOR = `140-${'5'.repeat(87)}-1`;

void test('a link to a seller page keeps the range and the verified filter only', () => {
  assert.equal(sellerHref(NODE), `/sellers/${NODE}`);
  const query = readQuery({
    range: '7',
    verified: '1',
    modelsPage: '2',
    before: CURSOR,
    txPage: '2',
    modelsRange: '90',
    sellersSort: '-input',
  });
  assert.equal(sellerHref(NODE, query), `/sellers/${NODE}?range=7&verified=1`);
  assert.equal(sellerHref(NODE, readQuery({})), `/sellers/${NODE}`);
});

void test('node states have one named member each', () => {
  assert.deepEqual([...NODE_STATES], Object.values(NODE_STATE));
  assert.deepEqual(NODE_STATE, {
    online: 'online',
    offline: 'offline',
    unpublished: 'unpublished',
  });
});

void test('a page fragment names its target, and a malformed one names none', () => {
  assert.equal(hashTarget('#channel-transactions'), 'channel-transactions');
  assert.equal(hashTarget('#a%20b'), 'a b');
  for (const bad of ['', '#', '#%E0%A4%A', '#%'])
    assert.equal(hashTarget(bad), null, bad);
});

void test('the models served count says when it reached the collector cap', () => {
  assert.equal(DISPLAY.maxPublicModels, AGGREGATES.maxPublicModels);
  assert.equal(modelsServedText(3), '3');
  assert.equal(modelsServedText(DISPLAY.maxPublicModels), '100+');
});

void test('the models note never calls a model not offered when offers are unknown', () => {
  assert.match(modelsNote(true, true), /not offered now/);
  assert.doesNotMatch(modelsNote(true, false), /not offered now/);
  assert.match(modelsNote(true, false), /current offers unavailable/);
  assert.match(modelsNote(false, true), /requests unavailable/);
});
