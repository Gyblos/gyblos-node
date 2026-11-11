// Mainnet policy preparation is local; addresses and signers below are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS } from '@x402/svm';

import { mainnetPilotBuyerPolicy } from '@gyblos/payments-upto';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

const rejected = (error: unknown) =>
  error instanceof PaymentError &&
  error.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS;

void test('mainnet candidate pins the network, USDC and fee within the pilot cap', async () => {
  const treasury = (await generateKeyPairSigner()).address;
  for (const maxAtomic of ['1', '1000000'])
    assert.deepEqual(mainnetPilotBuyerPolicy({ treasury, maxAtomic }), {
      network: SOLANA_MAINNET_CAIP2,
      mint: USDC_MAINNET_ADDRESS,
      treasury,
      protocolFeeBps: 400,
      maxAtomic,
    });
});

void test('mainnet candidate refuses malformed treasury and pilot deposit', async () => {
  const treasury = (await generateKeyPairSigner()).address;
  for (const maxAtomic of ['0', '1000001', '01', '-1', 'a', ''])
    assert.throws(
      () => mainnetPilotBuyerPolicy({ treasury, maxAtomic }),
      rejected,
    );
  assert.throws(
    () => mainnetPilotBuyerPolicy({ treasury: 'invalid', maxAtomic: '1' }),
    rejected,
  );
});
