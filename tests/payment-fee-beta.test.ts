// Pins the devnet beta's approximate collection separately from its 4% seller-net price surcharge.
// Pure public protocol entries only; no payments, keys or chain access.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVNET_TREASURY_OWNER, PROTOCOL_FEE } from '@gyblos/config';
import {
  feeSplitBps,
  grossAtomicPerMtok,
  settlementShares,
} from '@gyblos/protocol/payment-binding';

void test('devnet beta pins a 4% net surcharge and its approximate 9616/384 split', () => {
  assert.equal(PROTOCOL_FEE.bps, 400);
  assert.notEqual(PROTOCOL_FEE.treasury, DEVNET_TREASURY_OWNER);
  assert.deepEqual(feeSplitBps(PROTOCOL_FEE.bps), {
    sellerBps: 9616,
    treasuryBps: 384,
  });
  for (const [net, gross] of [
    ['0', '0'],
    ['1', '2'],
    ['25', '26'],
    ['100', '104'],
    ['1000000', '1040000'],
  ] as const)
    assert.equal(grossAtomicPerMtok(net, PROTOCOL_FEE.bps), gross);
});

void test('beta collection keeps seller, Gyblos and program residual amounts distinct', () => {
  for (const [charged, seller, fee, residual] of [
    ['0', '0', '0', '0'],
    ['1', '0', '0', '1'],
    ['26', '25', '0', '1'],
    ['27', '25', '1', '1'],
    ['625', '601', '24', '0'],
    ['1040000', '1000064', '39936', '0'],
  ] as const) {
    const shares = settlementShares(charged, PROTOCOL_FEE.bps);
    assert.deepEqual(shares, { sellerAtomic: seller, feeAtomic: fee });
    assert.equal(
      BigInt(charged) - BigInt(shares.sellerAtomic) - BigInt(shares.feeAtomic),
      BigInt(residual),
    );
  }
  // A net rate of 1,000,000 charges 1,040,000 for a million tokens, but Gyblos receives 39,936.
  assert.notEqual(
    settlementShares('1040000', PROTOCOL_FEE.bps).feeAtomic,
    '40000',
  );
});

void test('all 625 beta split residue classes conserve the charge with zero or one residual atom', () => {
  for (let residue = 0n; residue < 625n; residue++) {
    const charged = 625n + residue;
    const shares = settlementShares(String(charged), PROTOCOL_FEE.bps);
    // Independent reduced fractions pin the expected payouts instead of reusing feeSplitBps.
    assert.deepEqual(shares, {
      sellerAtomic: String((charged * 601n) / 625n),
      feeAtomic: String((charged * 24n) / 625n),
    });
    const residual =
      charged - BigInt(shares.sellerAtomic) - BigInt(shares.feeAtomic);
    assert.equal(residual, residue === 0n ? 0n : 1n, String(charged));
    assert.equal(
      BigInt(shares.sellerAtomic) + BigInt(shares.feeAtomic) + residual,
      charged,
    );
  }
});
