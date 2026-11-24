import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentPage,
  FULL_OVERVIEW,
  overviewLayout,
} from '@gyblos/explorer/layout';

void test('the page menu names the page the path belongs to, and nothing for an unknown path', () => {
  assert.equal(currentPage('/')?.label, 'Network');
  assert.equal(currentPage('/sellers')?.label, 'Sellers');
  assert.equal(currentPage(`/sellers/${'a'.repeat(64)}`)?.label, 'Sellers');
  assert.equal(currentPage('/stats')?.label, 'Stats');
  assert.equal(currentPage('/transactions')?.label, 'Transactions');
  assert.equal(currentPage('/nowhere'), undefined);
});

void test('overview cards never leave one alone in a row', () => {
  const five = overviewLayout(FULL_OVERVIEW);
  assert.equal(FULL_OVERVIEW, 5);
  assert.equal(five.spans.length, FULL_OVERVIEW);
  assert.match(five.grid, /lg:grid-cols-6/);
  assert.match(five.grid, /xl:grid-cols-5/);
  assert.match(five.spans[0]!, /^col-span-2 /);
  const lg = five.spans.map((span) =>
    Number(/lg:col-span-(\d)/.exec(span)?.[1]),
  );
  assert.deepEqual(lg, [2, 2, 2, 3, 3]);
  const four = overviewLayout(4);
  assert.match(four.grid, /xl:grid-cols-4/);
  assert.deepEqual(four.spans, ['', '', '', '']);
});
