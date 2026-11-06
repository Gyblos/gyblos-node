// Keeps paid quote payout and authorization identities separate using synthetic signers only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { CONTROL_CODES } from '@gyblos/protocol/constants';

import { controlFixture } from './support/control-fixture';

void test('paid quote refuses payout as authorizer independently of the fee payer', async () => {
  const paid = await controlFixture();
  paid.context.authorizer = paid.context.payTo;
  paid.context.feePayer = (await generateKeyPairSigner()).address;
  await assert.rejects(
    createControlQuote(paid.request, paid.context, paid.ownerSigner),
    { code: CONTROL_CODES.POLICY },
  );
});
