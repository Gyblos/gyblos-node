// Checks the lab paid-gate runner: preflight before payment, both balance deltas and no apparent
// success from overcharge, missing refund, gas charge or an open channel. No funded wallets or services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runGate,
  verifyAccounting,
  type GateReceipt,
} from '@gyblos/lab-harness/gate';

const before = { buyer: '1000000', seller: '0', buyerLamports: '0' };
const after = { buyer: '996000', seller: '4000', buyerLamports: '0' };
const receipt: GateReceipt = {
  authorized: '10000',
  actual: '4000',
  channelId: 'channel',
  openTransaction: 'open',
  claimTransaction: 'claim',
  channelDistributed: true,
};

void test('application gate can be called without a CLI and proves both balance deltas', async () => {
  const calls: string[] = [];
  let snapshots = 0;
  const result = await runGate({
    preflight: async () => {
      calls.push('preflight');
    },
    snapshot: async () => {
      calls.push('snapshot');
      return snapshots++ === 0 ? before : after;
    },
    request: async () => {
      calls.push('request');
      return { receipt, resource: 'fixture' };
    },
  });
  assert.deepEqual(calls, ['preflight', 'snapshot', 'request', 'snapshot']);
  assert.equal(result.accounting.refund, '6000');
});

void test('no apparent success from overcharge, missing refund, gas charge or open channel', () => {
  assert.throws(
    () => verifyAccounting(before, { ...after, buyer: '990000' }, receipt),
    /Buyer token delta/,
  );
  assert.throws(
    () => verifyAccounting(before, { ...after, seller: '0' }, receipt),
    /Seller token delta/,
  );
  assert.throws(
    () => verifyAccounting(before, { ...after, buyerLamports: '1' }, receipt),
    /Buyer SOL/,
  );
  assert.throws(
    () => verifyAccounting(before, after, { ...receipt, actual: '10001' }),
    /nonzero charge/,
  );
  assert.throws(
    () =>
      verifyAccounting(before, after, {
        ...receipt,
        channelDistributed: false,
      }),
    /undistributed/,
  );
  assert.throws(
    () =>
      verifyAccounting(before, after, { ...receipt, claimTransaction: 'open' }),
    /Distinct open/,
  );
});

void test('failed preflight cannot trigger a paid request', async () => {
  let requested = false;
  await assert.rejects(
    runGate({
      preflight: async () => {
        throw new Error('not funded');
      },
      snapshot: async () => before,
      request: async () => {
        requested = true;
        return { receipt, resource: null };
      },
    }),
  );
  assert.equal(requested, false);
});
