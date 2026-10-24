// Verifies malformed caller containers return selection codes without hiding dependency failures.
// Synthetic boundary inputs only; no discovery, transport, engines or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import {
  selectSellers,
  type SellerSelectionInput,
} from '@gyblos/core/seller-selection';

import {
  nodeId,
  NOW,
  request,
  seeded,
  seller,
} from './support/seller-selection-fixture.js';

function validInput(): SellerSelectionInput {
  return {
    request: request(),
    sellers: [seller(1)],
    stats: new Map(),
    now: NOW,
    random: seeded(1),
  };
}
function rejectsInvalid(input: unknown) {
  // Deliberately invalid external boundary data must exercise runtime validation.
  assert.deepEqual(selectSellers(input as SellerSelectionInput), {
    ok: false,
    code: SELLER_SELECTION_CODES.INVALID,
  });
}
void test('selection rejects null and malformed top-level input with a typed result', () => {
  for (const value of [null, undefined, 42, 'synthetic', [], {}])
    rejectsInvalid(value);
});
void test('selection rejects null and malformed request containers with a typed result', () => {
  for (const value of [null, undefined, 42, 'synthetic', [], {}])
    rejectsInvalid({ ...validInput(), request: value });
});
void test('selection rejects null and malformed seller containers with a typed result', () => {
  for (const value of [
    null,
    undefined,
    42,
    'synthetic',
    [],
    {},
    { catalog: null },
  ])
    rejectsInvalid({ ...validInput(), sellers: [value] });
});
void test('selection rejects null and malformed stats entries without hiding RNG failures', () => {
  for (const value of [null, undefined, 42, 'synthetic', [], {}])
    rejectsInvalid({ ...validInput(), stats: new Map([[nodeId(1), value]]) });
  const failure = new Error('Synthetic random source failure');
  assert.throws(
    () =>
      selectSellers({
        ...validInput(),
        random: () => {
          throw failure;
        },
      }),
    (error) => error === failure,
  );
});
