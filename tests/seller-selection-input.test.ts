// Verifies malformed caller containers and records return selection codes without hiding dependency
// failures. Synthetic boundary inputs only; no discovery, transport, engines or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import {
  selectSellers,
  type KnownSeller,
  type SellerSelectionInput,
} from '@gyblos/core/seller-selection';

import {
  history,
  MODEL,
  nodeId,
  NOW,
  request,
  seeded,
  select,
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
const invalid = { ok: false, code: SELLER_SELECTION_CODES.INVALID };

// Rewrites the only listing of a valid seller; the result is deliberately invalid boundary data.
function withListing(patch: Record<string, unknown>) {
  const base = seller(1);
  const [listing] = base.catalog.models;
  return {
    ...base,
    catalog: { ...base.catalog, models: [{ ...listing, ...patch }] },
  } as unknown as KnownSeller;
}

void test('null or partial records return the typed invalid code instead of throwing', () => {
  const base = seller(1);
  const cases: Partial<SellerSelectionInput>[] = [
    { request: null as unknown as SellerSelectionInput['request'] },
    { request: { ...request(), priceCeilings: null } as never },
    { request: { ...request(), selection: null } as never },
    { sellers: [null as unknown as KnownSeller] },
    { sellers: [{ ...base, catalog: undefined } as unknown as KnownSeller] },
    {
      sellers: [
        {
          ...base,
          catalog: { ...base.catalog, models: null },
        } as unknown as KnownSeller,
      ],
    },
    { sellers: [{ ...base, presence: 'fresh' } as unknown as KnownSeller] },
    { sellers: [{ ...base, withdrawal: 1 } as unknown as KnownSeller] },
    { stats: new Map([[nodeId(1), null]]) as never },
  ];
  for (const overrides of cases)
    assert.deepEqual(select([seller(1)], overrides), invalid);
});
void test('count, openChannel, reasoning and selection fields must have their declared types', () => {
  const cases: Partial<SellerSelectionInput>[] = [
    { count: null as unknown as number },
    {
      sellers: [
        { ...seller(1), openChannel: 'false' } as unknown as KnownSeller,
      ],
    },
    { sellers: [withListing({ reasoning: 'off,high' })] },
    { sellers: [withListing({ reasoning: ['ultra'] })] },
    { sellers: [withListing({ variant: 1 })] },
    { sellers: [withListing({ quantization: false })] },
    { request: request({ selection: { ...MODEL, variant: 7 } as never }) },
    {
      request: request({
        selection: { ...MODEL, quantization: undefined } as never,
      }),
    },
  ];
  for (const overrides of cases)
    assert.deepEqual(select([seller(1)], overrides), invalid);
  assert.equal(
    select([seller(1)], {
      stats: new Map([[nodeId(1), history()]]),
    }).ok,
    true,
  );
});
