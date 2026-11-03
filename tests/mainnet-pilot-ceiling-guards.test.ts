// Offline pilot policy checks use public network constants and synthetic amounts only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS } from '@x402/svm';

import { DEVNET } from '@gyblos/config';
import { assertMainnetPilotDeposit } from '@gyblos/payments-upto';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

const code = (error: unknown) =>
  error instanceof PaymentError &&
  error.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS;

void test('mainnet accepts only positive canonical USDC deposits up to one USDC', () => {
  for (const maxAtomic of ['1', '999999', '1000000'])
    assert.doesNotThrow(() =>
      assertMainnetPilotDeposit({
        network: SOLANA_MAINNET_CAIP2,
        mint: USDC_MAINNET_ADDRESS,
        maxAtomic,
      }),
    );
  for (const maxAtomic of [
    '0',
    '1000001',
    '99999999999999999999',
    '01',
    '-1',
    '1.0',
    '',
  ])
    assert.throws(
      () =>
        assertMainnetPilotDeposit({
          network: SOLANA_MAINNET_CAIP2,
          mint: USDC_MAINNET_ADDRESS,
          maxAtomic,
        }),
      code,
    );
  assert.throws(
    () =>
      assertMainnetPilotDeposit({
        network: SOLANA_MAINNET_CAIP2,
        mint: 'synthetic-other-asset',
        maxAtomic: '1',
      }),
    code,
  );
});

void test('the pilot guard leaves existing devnet terms unchanged', () => {
  assert.doesNotThrow(() =>
    assertMainnetPilotDeposit({
      network: DEVNET,
      mint: 'synthetic-devnet-asset',
      maxAtomic: '1000001',
    }),
  );
});
