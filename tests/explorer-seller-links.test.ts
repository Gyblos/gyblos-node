import assert from 'node:assert/strict';
import test from 'node:test';

import { NODE_STATE, NODE_STATES } from '@gyblos/explorer/network-status';
import { readQuery } from '@gyblos/explorer/paging';
import { sellerHref } from '@gyblos/explorer/seller-identity';

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
