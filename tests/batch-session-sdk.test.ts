// The SDK must open a capped client-signed channel without charging for work not delivered yet.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockhash, generateKeyPairSigner } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@x402/svm';
import { buildDepositPayload } from '@x402/svm/batch-settlement/client';

async function argumentsFor(firstCharge: bigint) {
  const payer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  return {
    payer,
    receiver: seller.address,
    receiverAuthorizer: seller.address,
    mint: mint.address,
    feePayer: feePayer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    blockhash: {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 1000n,
    },
    openSlot: 1n,
    depositAmount: 1000n,
    firstCharge,
    withdrawDelay: 300,
  };
}
void test('batch SDK default still refuses a zero first charge', async () => {
  await assert.rejects(
    buildDepositPayload(await argumentsFor(0n)),
    /first charge/,
  );
});
void test('batch SDK opt-in opens at zero with a buyer-signed zero voucher', async () => {
  const args = { ...(await argumentsFor(0n)), allowZeroFirstCharge: true };
  const built = await buildDepositPayload(args);
  assert.equal(built.payload.voucher?.maxClaimableAmount, '0');
  assert.equal(built.payload.channelConfig.payerAuthorizer, args.payer.address);
  assert.equal(built.payload.deposit.amount, '1000');
  assert.equal(built.tracker.cumulative, 0n);
});
void test('batch SDK default positive first charge remains unchanged', async () => {
  const built = await buildDepositPayload(await argumentsFor(10n));
  assert.equal(built.payload.voucher?.maxClaimableAmount, '10');
});
