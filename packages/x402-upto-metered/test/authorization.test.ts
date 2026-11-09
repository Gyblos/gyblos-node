// The real @x402/svm upto client builds the channel open and the real facilitator verifies it,
// both offline: only addresses and recent-block hints are supplied.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUptoAuthorization,
  createUptoVerifier,
  UPTO_ERROR_CODES,
  uptoRequirements,
} from '../src/index';
import { parties } from './support';

void test('a client-built channel open verifies against the same terms', async () => {
  const { payer, feePayer, terms, hints } = await parties();
  const authorization = await createUptoAuthorization(payer, terms, hints);
  assert.equal(authorization.payer, payer.address);
  assert.equal(authorization.maxAtomic, terms.maxAtomic);
  const verify = createUptoVerifier(feePayer.address, async () =>
    BigInt(hints.recentSlot),
  );
  assert.equal(await verify(authorization, terms), true);
});

void test('any change to the money terms fails verification', async () => {
  const { payer, feePayer, terms, hints } = await parties();
  const authorization = await createUptoAuthorization(payer, terms, hints);
  const verify = createUptoVerifier(feePayer.address, async () =>
    BigInt(hints.recentSlot),
  );
  for (const changed of [
    { memo: `gyblos:${'cd'.repeat(32)}` },
    { maxAtomic: '1029999' },
    { payTo: feePayer.address },
    { authorizer: payer.address },
  ])
    assert.equal(
      await verify(authorization, { ...terms, ...changed }),
      false,
      JSON.stringify(changed),
    );
  assert.equal(
    await verify({ ...authorization, payer: feePayer.address }, terms),
    false,
  );
  assert.equal(
    await verify({ ...authorization, payload: 'e30=' }, terms),
    false,
  );
});

void test('requirements carry the terms and the client hints, never anything else', async () => {
  const { terms, hints } = await parties();
  const requirements = uptoRequirements(terms, hints);
  assert.equal(requirements.scheme, 'upto');
  assert.equal(requirements.amount, terms.maxAtomic);
  assert.equal(requirements.payTo, terms.payTo);
  assert.equal(requirements.extra?.memo, terms.memo);
  assert.equal(requirements.extra?.recentSlot, hints.recentSlot);
  assert.equal(uptoRequirements(terms).extra?.recentSlot, undefined);
});

void test('an open from a far older slot than the chain is refused', async () => {
  const { payer, feePayer, terms, hints } = await parties();
  const authorization = await createUptoAuthorization(payer, terms, hints);
  const current = BigInt(hints.recentSlot);
  assert.equal(
    await createUptoVerifier(feePayer.address, async () => current + 2n)(
      authorization,
      terms,
    ),
    true,
  );
  assert.equal(
    await createUptoVerifier(
      feePayer.address,
      async () => current + 1_000_000n,
    )(authorization, terms),
    false,
  );
});

void test('the authorization must describe its own payload', async () => {
  const { payer, feePayer, terms, hints } = await parties();
  const authorization = await createUptoAuthorization(payer, terms, hints);
  const verify = createUptoVerifier(feePayer.address, async () =>
    BigInt(hints.recentSlot),
  );
  for (const changed of [
    { channelId: feePayer.address },
    { maxAtomic: '1' },
    { payer: feePayer.address },
  ])
    assert.equal(await verify({ ...authorization, ...changed }, terms), false);
});

void test('oversized or non-canonical payloads never reach the SDK', async () => {
  const { payer, feePayer, terms, hints } = await parties();
  const authorization = await createUptoAuthorization(payer, terms, hints);
  const verify = createUptoVerifier(feePayer.address, async () =>
    BigInt(hints.recentSlot),
  );
  const padded = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(authorization.payload, 'base64').toString()),
      padding: 'x'.repeat(4096),
    }),
  ).toString('base64');
  for (const payload of [
    padded,
    `${authorization.payload} `,
    Buffer.from('[1]').toString('base64'),
  ])
    assert.equal(await verify({ ...authorization, payload }, terms), false);
});

void test('checkpoint mode refuses modifying or sending signers before preparation', async () => {
  const { payer, terms, hints } = await parties();
  let calls = 0;
  const unsupported = async () => {
    calls++;
    throw new Error('must not ask a modifying or sending wallet');
  };
  for (const signer of [
    { address: payer.address, modifyAndSignTransactions: unsupported },
    { address: payer.address, signAndSendTransactions: unsupported },
  ]) {
    await assert.rejects(
      createUptoAuthorization(signer, terms, hints, async () => {
        calls++;
      }),
      { code: UPTO_ERROR_CODES.INVALID_TERMS },
    );
  }
  assert.equal(calls, 0);
});

void test('a wallet cannot change the prepared message or return an invalid signature', async () => {
  const { payer, terms, hints } = await parties();
  for (const changeMessage of [true, false]) {
    let checkpointed = false;
    await assert.rejects(
      createUptoAuthorization(
        {
          address: payer.address,
          async signTransactions(transactions, ...rest) {
            assert.equal(checkpointed, true);
            const signatures = await payer.signTransactions(
              transactions,
              ...rest,
            );
            const target = changeMessage
              ? transactions[0]?.messageBytes
              : signatures[0]?.[payer.address];
            assert.ok(target);
            const bytes = new Uint8Array(
              target.buffer,
              target.byteOffset,
              target.byteLength,
            );
            bytes[0] = bytes[0]! ^ 1;
            return signatures;
          },
        },
        terms,
        hints,
        async () => {
          checkpointed = true;
        },
      ),
      { code: UPTO_ERROR_CODES.INTERNAL },
    );
  }
});
