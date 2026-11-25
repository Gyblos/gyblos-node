import assert from 'node:assert/strict';
import test from 'node:test';

import { groupPrice } from '@gyblos/desktop/model-price';

void test('mixed offer groups disclose paid sellers regardless of announcement order', () => {
  const free = {
    id: 'a',
    name: 'Model',
    image: { src: '' },
    free: true,
    input: 0,
    output: 0,
  };
  const paid = { ...free, id: 'b', free: false, input: 1, output: 2 };
  assert.equal(groupPrice([free, paid]), 'Free and paid');
  assert.equal(groupPrice([paid, free]), 'Free and paid');
  assert.equal(groupPrice([free]), 'Free');
});
