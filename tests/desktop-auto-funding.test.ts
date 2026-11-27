import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVNET } from '@gyblos/config/network';
import { autoFundingAvailable, FUNDING } from '@gyblos/desktop/funding-model';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

const payer = '11111111111111111111111111111111';

void test('Auto checks reusable channel funds before asking for a new deposit', () => {
  const policy = { payer, maxAtomic: '10000', depositAtomic: '1000000' };
  const zero = {
    payer,
    network: DEVNET,
    balanceAtomic: '0',
    channelRemainingAtomic: null,
    faucetAvailable: true,
  };
  assert.equal(
    autoFundingAvailable({ ...policy, maxAtomic: '1' }, [
      { ...zero, balanceAtomic: '1000000', replacementAtomic: '10' },
    ]),
    FUNDING.channelLimit,
  );
  assert.equal(autoFundingAvailable(policy, [zero]), false);
  assert.equal(
    autoFundingAvailable(policy, [
      zero,
      { ...zero, channelRemainingAtomic: '15000' },
    ]),
    true,
  );
  assert.equal(
    autoFundingAvailable(policy, [{ ...zero, balanceAtomic: null }]),
    null,
  );
});

void test('a closed channel explains the paid seller refusal independently of available wallet evidence', () => {
  for (const balanceAtomic of [null, '0', '2000000']) {
    const policy = { payer, maxAtomic: '10000', depositAtomic: '1000000' };
    const funding = {
      payer,
      network: DEVNET,
      balanceAtomic,
      channelBlocker: SESSION_CODES.CLOSED,
      channelRemainingAtomic: null,
      faucetAvailable: balanceAtomic !== null,
    };
    assert.equal(autoFundingAvailable(policy, [funding]), SESSION_CODES.CLOSED);
  }
});
