import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import type { PaymentRequirements } from '@x402/core/types';

import { EXACT_PRICE } from '@gyblos/core/constants';
import {
  DEVNET,
  DEVNET_USDC,
  PUBLIC_CALL_OPERATIONS,
  PUBLIC_CALL_OUTCOMES,
} from '@gyblos/payments-x402/constants';
import {
  assertExactFallbackSafe,
  assertExactSupport,
  createExactBuyer,
  validateExactTerms,
} from '@gyblos/payments-x402/exact/index';

const policy = { payTo: 'seller', feePayer: 'sponsor', amount: EXACT_PRICE };
const terms: PaymentRequirements = {
  scheme: 'exact',
  network: DEVNET,
  asset: DEVNET_USDC,
  amount: EXACT_PRICE,
  payTo: policy.payTo,
  maxTimeoutSeconds: 60,
  extra: { feePayer: policy.feePayer, paymentFlow: 'upfront' },
};
test('exact policy pins network, Circle mint, exact price, recipient, sponsor and upfront flow', () => {
  validateExactTerms(terms, policy);
  for (const change of [
    { network: 'solana:mainnet' as const },
    { asset: 'other-mint' },
    { payTo: 'attacker' },
    { amount: '10001' },
    { scheme: 'upto' },
    { extra: { ...terms.extra, feePayer: 'attacker' } },
    { extra: { ...terms.extra, paymentFlow: 'authorization' } },
  ])
    assert.throws(
      () => validateExactTerms({ ...terms, ...change }, policy),
      /Exact terms/,
    );
});
for (const field of ['asset', 'payTo', 'feePayer'] as const)
  test(`untrusted exact ${field} is rejected before any signer call`, async () => {
    const signer = await generateKeyPairSigner();
    let signed = 0;
    const buyer = createExactBuyer(
      {
        ...signer,
        async signTransactions() {
          signed++;
          throw new Error('must not sign');
        },
      },
      'http://127.0.0.1:9',
      policy,
    );
    const bad =
      field === 'feePayer'
        ? { ...terms, extra: { ...terms.extra, feePayer: 'attacker' } }
        : { ...terms, [field]: 'attacker' };
    await assert.rejects(
      buyer.authorize(
        {
          x402Version: 2,
          resource: {
            url: 'http://localhost/api/exact',
            description: 'fixture',
            mimeType: 'application/json',
          },
          accepts: [bad],
        },
        EXACT_PRICE,
      ),
      /Exact terms/,
    );
    assert.equal(signed, 0);
  });
test('changed public facilitator scheme or fee payer stops the gate', () => {
  const support = {
    kinds: [
      {
        x402Version: 2,
        scheme: 'exact',
        network: DEVNET,
        extra: { feePayer: 'sponsor' },
      },
    ],
    extensions: [],
    signers: {},
  };
  assertExactSupport(support, 'sponsor');
  assert.throws(() => assertExactSupport(support, 'changed'), /changed/);
  assert.throws(
    () => assertExactSupport({ ...support, kinds: [] }, 'sponsor'),
    /changed/,
  );
});

test('a settlement attempt with empty history cannot authorize fallback after confirmation failure', () => {
  let secondAuthorizations = 0;
  const sentThenConfirmationFailed = [
    {
      operation: PUBLIC_CALL_OPERATIONS.VERIFY,
      outcome: PUBLIC_CALL_OUTCOMES.SUCCESS,
    },
    {
      operation: PUBLIC_CALL_OPERATIONS.SETTLE,
      outcome: PUBLIC_CALL_OUTCOMES.UNCERTAIN,
    },
  ];
  assert.throws(() => {
    assertExactFallbackSafe(sentThenConfirmationFailed);
    secondAuthorizations++;
  }, /Cannot switch facilitator/);
  assert.equal(secondAuthorizations, 0);
  assertExactFallbackSafe([
    {
      operation: PUBLIC_CALL_OPERATIONS.VERIFY,
      outcome: PUBLIC_CALL_OUTCOMES.REJECTED,
    },
  ]);
});

test('empty Circle USDC balance is rejected before signing', async () => {
  const signer = await generateKeyPairSigner();
  let signed = false;
  const buyer = createExactBuyer(
    {
      ...signer,
      async signTransactions() {
        signed = true;
        throw new Error('must not sign');
      },
    },
    'http://127.0.0.1:9',
    policy,
  );
  await assert.rejects(
    buyer.authorize(
      {
        x402Version: 2,
        resource: {
          url: 'http://localhost/api/exact',
          description: 'fixture',
          mimeType: 'application/json',
        },
        accepts: [terms],
      },
      '0',
    ),
    /insufficient Circle/,
  );
  assert.equal(signed, false);
});

test('an uncertain exact journal blocks the shared authorization guard', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { assertNoUnresolvedAuthorizations } =
    await import('@gyblos/lab-harness/journal');
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-exact-'));
  const path = join(directory, 'exact-attempt.json');
  try {
    await writeFile(path, JSON.stringify({ state: 'uncertain' }));
    await assert.rejects(
      assertNoUnresolvedAuthorizations([path] as Parameters<
        typeof assertNoUnresolvedAuthorizations
      >[0]),
      /Authorization may be unsettled/,
    );
    await writeFile(path, JSON.stringify({ state: 'confirmed' }));
    await assertNoUnresolvedAuthorizations([path] as Parameters<
      typeof assertNoUnresolvedAuthorizations
    >[0]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('replay ID ignores equivalent base64 and the facilitator co-signature', async () => {
  const {
    compileTransaction,
    createTransactionMessage,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    blockhash,
    getBase64EncodedWireTransaction,
  } = await import('@solana/kit');
  const { exactAuthorizationId } =
    await import('@gyblos/payments-x402/exact/authorization-id');
  const signer = await generateKeyPairSigner();
  const message = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 1n,
    },
    setTransactionMessageFeePayer(
      signer.address,
      createTransactionMessage({ version: 0 }),
    ),
  );
  const tx = compileTransaction(message);
  const unsigned = getBase64EncodedWireTransaction(tx);
  const cosigned = getBase64EncodedWireTransaction({
    ...tx,
    signatures: {
      ...tx.signatures,
      [signer.address]: new Uint8Array(64).fill(1),
    },
  });
  assert.notEqual(unsigned, cosigned);
  assert.equal(exactAuthorizationId(unsigned), exactAuthorizationId(cosigned));
  assert.equal(
    exactAuthorizationId(unsigned),
    exactAuthorizationId(unsigned.replace(/=+$/, '')),
  );
});
