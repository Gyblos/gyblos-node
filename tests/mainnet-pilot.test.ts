// The mainnet pilot ceiling is expressed in six-decimal USDC atomic units.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isMainnetPilotDepositAllowed } from '@gyblos/core/mainnet-pilot';

void test('mainnet pilot allows positive USDC deposits up to one USDC', () => {
  for (const amount of ['1', '999999', '1000000']) {
    assert.equal(isMainnetPilotDepositAllowed(amount), true);
  }
});

void test('mainnet pilot rejects amounts above the ceiling and invalid encodings', () => {
  for (const amount of [
    '0',
    '1000001',
    '999999999999999999999999999999999999',
    '01',
    '-1',
    '1.0',
    ' 1',
    '',
    1,
    null,
    undefined,
  ]) {
    assert.equal(isMainnetPilotDepositAllowed(amount), false);
  }
});
