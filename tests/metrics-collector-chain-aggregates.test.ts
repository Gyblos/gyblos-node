// Protects the chain aggregate formulas (#349): real devnet transactions add up per UTC day in both
// scopes; a settle adds only what it raised the channel's running maximum; amounts count devnet USDC
// only and never fail a day; payouts are split by who received them, never exceed what left the vault,
// and a batch with another channel's payout never adds to Gyblos; failed and unreadable transactions
// stay in the program scope.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVNET_GYBLOS_TREASURY,
  DEVNET_TREASURY_OWNER,
  DEVNET_USDC,
} from '@gyblos/config/network';
import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import { AGGREGATES } from '@gyblos/metrics-collector/constants';

import { endpoints, fakeChainRpc } from './support/metrics-collector-chain';
import {
  chainRows,
  channel,
  day,
  DAY_MS,
  DAY1,
  delta,
  fund,
  instruction,
  LAB_MINT,
  lifecycle,
  OTHER_MINT,
  tx,
} from './support/metrics-collector-chain-rows';
import { createCollectorD1 } from './support/metrics-collector-d1';

void test('the real devnet lifecycle adds up in full for Gyblos, counted for the program, in USDC only', async () => {
  const database = createCollectorD1();
  await runChainIndex(
    database,
    endpoints(fakeChainRpc(lifecycle(DEVNET_USDC)).rpc),
    1000,
  );
  const result = await runAggregation(database, 2000);
  assert.deepEqual(result.chain.days, ['2026-11-02']);
  const expected = {
    day: '2026-11-02',
    transactions: 3,
    failed: 0,
    undecodable: 0,
    opens: 1,
    settles: 0,
    top_ups: 0,
    settle_and_seals: 1,
    request_closes: 0,
    seals: 0,
    distributes: 1,
    reclaims: 1,
    channels: 1,
    payers: 1,
    payees: 1,
    // Deposited 10000, settled 145; distribute sent the 145 to the program treasury (the payout was
    // redirected) and refunded 9855 to the payer.
    deposited_atomic: '10000',
    settled_atomic: '145',
    gyblos_fees_atomic: '0',
    program_treasury_atomic: '145',
    refunded_atomic: '9855',
    paid_out_atomic: '0',
    formula_version: AGGREGATES.formulaVersion,
    aggregated_at: 2000,
  };
  // The open's memo claims Gyblos traffic: its channel is read in full.
  assert.deepEqual(chainRows(database, 'gyblos'), [
    { ...expected, scope: 'gyblos' },
  ]);
  // The whole program only counts its transactions.
  const zero = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      typeof value === 'string' && key.endsWith('_atomic') ? '0' : value,
    ]),
  );
  assert.deepEqual(chainRows(database, 'program'), [
    {
      ...zero,
      scope: 'program',
      opens: 0,
      settle_and_seals: 0,
      distributes: 0,
      reclaims: 0,
      channels: 0,
      payers: 0,
      payees: 0,
    },
  ]);

  // The same lifecycle in another mint is counted, with no USDC amount.
  const lab = createCollectorD1();
  await runChainIndex(
    lab,
    endpoints(fakeChainRpc(lifecycle(LAB_MINT)).rpc),
    1000,
  );
  await runAggregation(lab, 2000);
  const [row] = chainRows(lab, 'gyblos');
  assert.deepEqual(
    [
      row!.transactions,
      row!.deposited_atomic,
      row!.settled_atomic,
      row!.refunded_atomic,
    ],
    [3, '0', '0', '0'],
  );
});

void test('a settle adds only what its cumulative grew, in chain order', async () => {
  const database = createCollectorD1();
  channel(database, 'A', {
    payer: 'payer',
    payee: 'seller',
    mint: DEVNET_USDC,
    gyblos: 1,
  });
  // A channel with no Gyblos claim is never in the Gyblos rows.
  channel(database, 'B', {
    payer: 'payer',
    payee: 'seller',
    mint: DEVNET_USDC,
    gyblos: 0,
  });
  fund(database, 'A');
  fund(database, 'B');
  tx(database, 'a1', DAY1, 1);
  instruction(database, 'a1', 0, 'settle', 'A', { cumulative: '100' });
  tx(database, 'a2', DAY1 + DAY_MS, 1);
  instruction(database, 'a2', 0, 'settle', 'A', { cumulative: '250' });
  // The same voucher again adds nothing.
  tx(database, 'a3', DAY1 + DAY_MS + 1000, 1);
  instruction(database, 'a3', 0, 'settle_and_seal', 'A', { cumulative: '250' });
  // A seal without a voucher has no cumulative.
  instruction(database, 'a3', 1, 'seal', 'A');
  // Two settles in one slot are ordered by cumulative; a lower one never subtracts.
  tx(database, 'a4', DAY1 + 2 * DAY_MS, 1, { slot: 9_000_000_000 });
  instruction(database, 'a4', 0, 'settle', 'A', { cumulative: '290' });
  tx(database, 'a5', DAY1 + 2 * DAY_MS + 1, 1, { slot: 9_000_000_000 });
  instruction(database, 'a5', 0, 'settle', 'A', { cumulative: '280' });
  tx(database, 'b1', DAY1 + DAY_MS, 1);
  instruction(database, 'b1', 0, 'settle', 'B', { cumulative: '7' });
  await runAggregation(database, DAY1 + 3 * DAY_MS);

  const settled = (scope: string) =>
    chainRows(database, scope).map((row) => [row.day, row.settled_atomic]);
  assert.deepEqual(settled('gyblos'), [
    [day(DAY1), '100'],
    [day(DAY1 + DAY_MS), '150'],
    [day(DAY1 + 2 * DAY_MS), '40'],
  ]);
  const [, second] = chainRows(database, 'gyblos');
  assert.deepEqual(
    [
      second!.transactions,
      second!.settles,
      second!.settle_and_seals,
      second!.seals,
      second!.channels,
    ],
    [2, 1, 1, 1, 1],
  );
});

void test('payouts are split by who received them, in USDC only', async () => {
  const database = createCollectorD1();
  channel(database, 'C', {
    payer: 'payer',
    payee: 'seller',
    mint: DEVNET_USDC,
    gyblos: 1,
  });
  tx(database, 'open', DAY1, 1);
  instruction(database, 'open', 0, 'open', 'C', { amount: '1000' });
  tx(database, 'top', DAY1 + 10, 1);
  instruction(database, 'top', 0, 'top_up', 'C', { amount: '500' });
  tx(database, 'pay', DAY1 + 20, 1);
  instruction(database, 'pay', 0, 'distribute', 'C');
  delta(database, 'pay', 'C', '-1500');
  delta(database, 'pay', 'seller', '960');
  delta(database, 'pay', DEVNET_GYBLOS_TREASURY, '40');
  delta(database, 'pay', DEVNET_TREASURY_OWNER, '1');
  delta(database, 'pay', 'payer', '499');
  delta(database, 'pay', 'seller', '77', OTHER_MINT);
  // Deposits move tokens too, but only paying transactions count as payouts.
  delta(database, 'open', 'C', '1000');
  await runAggregation(database, DAY1 + DAY_MS);
  const [row] = chainRows(database, 'gyblos');
  assert.deepEqual(
    [
      row!.deposited_atomic,
      row!.paid_out_atomic,
      row!.gyblos_fees_atomic,
      row!.program_treasury_atomic,
      row!.refunded_atomic,
    ],
    ['1500', '960', '40', '1', '499'],
  );
  assert.deepEqual(
    [row!.opens, row!.top_ups, row!.distributes, row!.payers, row!.payees],
    [1, 1, 1, 1, 1],
  );
});

void test('a payout batched with another channel never adds to the Gyblos scope', async () => {
  const database = createCollectorD1();
  channel(database, 'G', {
    payer: 'gp',
    payee: 'seller',
    mint: DEVNET_USDC,
    gyblos: 1,
  });
  channel(database, 'N', {
    payer: 'np',
    payee: 'other',
    mint: DEVNET_USDC,
    gyblos: 0,
  });
  tx(database, 'mixed', DAY1, 1);
  instruction(database, 'mixed', 0, 'distribute', 'G');
  instruction(database, 'mixed', 1, 'distribute', 'N');
  delta(database, 'mixed', 'G', '-10');
  delta(database, 'mixed', 'N', '-1500');
  delta(database, 'mixed', 'seller', '10');
  delta(database, 'mixed', 'other', '1000');
  delta(database, 'mixed', 'np', '500');
  tx(database, 'alone', DAY1 + 1, 1);
  instruction(database, 'alone', 0, 'distribute', 'G');
  delta(database, 'alone', 'G', '-7');
  delta(database, 'alone', 'seller', '3');
  delta(database, 'alone', 'gp', '4');
  await runAggregation(database, DAY1 + DAY_MS);
  const payouts = (scope: string) => {
    const [row] = chainRows(database, scope);
    return [row!.paid_out_atomic, row!.refunded_atomic, row!.distributes];
  };
  // The batch still counts as Gyblos activity; only its money is left out.
  assert.deepEqual(payouts('gyblos'), ['3', '4', 2]);
});

void test('alternating or huge vouchers never inflate or stop the settled total', async () => {
  const database = createCollectorD1();
  channel(database, 'H', { payer: 'p', payee: 's', mint: DEVNET_USDC });
  fund(database, 'H');
  ['100', '50', '100', '120'].forEach((cumulative, index) => {
    tx(database, `h${index}`, DAY1 + index, 1, { slot: 10 + index });
    instruction(database, `h${index}`, 0, 'settle', 'H', { cumulative });
  });
  channel(database, 'X', { payer: 'p', payee: 's', mint: DEVNET_USDC });
  fund(database, 'X', '18446744073709551615');
  ['18446744073709551615', '1', '18446744073709551615'].forEach(
    (cumulative, index) => {
      tx(database, `x${index}`, DAY1 + DAY_MS + index, 1, { slot: 20 + index });
      instruction(database, `x${index}`, 0, 'settle', 'X', { cumulative });
    },
  );
  const result = await runAggregation(database, DAY1 + 2 * DAY_MS);
  assert.deepEqual(result.chain.failed, []);
  const [first, second] = chainRows(database, 'gyblos');
  assert.equal(first!.settled_atomic, '120');
  // Saturated, never an error: the day is still written.
  assert.equal(second!.settles, 3);
});

void test('a voucher never settles more than the channel deposited', async () => {
  const database = createCollectorD1();
  channel(database, 'Q', { payer: 'p', payee: 's', mint: DEVNET_USDC });
  tx(database, 'q0', DAY1, 1, { slot: 1 });
  instruction(database, 'q0', 0, 'open', 'Q', { amount: '100' });
  tx(database, 'q1', DAY1 + 1, 1, { slot: 2 });
  instruction(database, 'q1', 0, 'settle', 'Q', { cumulative: '999999' });
  tx(database, 'q2', DAY1 + 2, 1, { slot: 3 });
  instruction(database, 'q2', 0, 'top_up', 'Q', { amount: '50' });
  await runAggregation(database, DAY1 + DAY_MS);
  const [row] = chainRows(database, 'gyblos');
  assert.equal(row!.settled_atomic, '150');
});

void test('payouts never exceed what left the vault, and unknown owners never count', async () => {
  const database = createCollectorD1();
  channel(database, 'V', {
    payer: 'payer',
    payee: 'seller',
    mint: DEVNET_USDC,
  });
  // A transfer from the payer's wallet to the payee bundled with the payout: more arrives than left.
  tx(database, 'bundled', DAY1, 1);
  instruction(database, 'bundled', 0, 'distribute', 'V');
  delta(database, 'bundled', 'V', '-100');
  delta(database, 'bundled', 'seller', '1100');
  delta(database, 'bundled', 'payer', '-1000');
  // A transfer to a stranger is ignored; the rest balances.
  tx(database, 'stranger', DAY1 + 1, 1);
  instruction(database, 'stranger', 0, 'reclaim', 'V');
  delta(database, 'stranger', 'V', '-30');
  delta(database, 'stranger', 'payer', '30');
  delta(database, 'stranger', 'someone', '5000');
  await runAggregation(database, DAY1 + DAY_MS);
  const [row] = chainRows(database, 'gyblos');
  assert.deepEqual([row!.paid_out_atomic, row!.refunded_atomic], ['0', '30']);
});

void test('the program row is its list counts; unreadable Gyblos transactions stay in the Gyblos row', async () => {
  const database = createCollectorD1();
  database.raw.exec(
    `INSERT INTO collector_chain_program_daily (day, transactions, failed, updated_at)
       VALUES ('${day(DAY1)}', 5, 2, 1);
     INSERT INTO collector_agg_chain_dirty_days (day) VALUES ('${day(DAY1)}');`,
  );
  tx(database, 'u1', DAY1 + 2, 1, { undecodable: 2 });
  await runAggregation(database, DAY1 + DAY_MS);
  const [program] = chainRows(database, 'program');
  assert.deepEqual(
    [program!.transactions, program!.failed, program!.undecodable],
    [5, 2, 0],
  );
  const [gyblos] = chainRows(database, 'gyblos');
  assert.deepEqual([gyblos!.transactions, gyblos!.undecodable], [0, 1]);
});
