import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_USDC } from '@gyblos/config/network';
import { x402Amount, x402StatAmount } from '@gyblos/desktop/x402-model';

const devnet = { mint: DEVNET_USDC };
const other = { mint: '11111111111111111111111111111111' };

void test('spending cards drop trailing zeros and the network suffix for devnet USDC', () => {
  assert.equal(x402StatAmount('0', devnet), '0 USDC');
  assert.equal(x402StatAmount('6000', devnet), '0.006 USDC');
  assert.equal(x402StatAmount('10000000', devnet), '10 USDC');
  assert.equal(x402StatAmount('1234567', devnet), '1.234567 USDC');
  assert.equal(x402Amount('6000', devnet), '0.006000');
});

void test('spending cards keep atomic units for other tokens', () => {
  assert.equal(x402StatAmount('120', other), '120 test-token atomic units');
});
