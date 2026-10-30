// The patched @x402/svm upto SDK opens and verifies channels whose distribution splits each charge
// between payTo and further recipients (a protocol fee), offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { createUptoAuthorization, createUptoVerifier } from '../src/index';
import { parties } from './support';

void test('a 97/3 distribution is signed by the payer and verified against the same terms', async () => {
  const { payer, feePayer, terms, hints } = await parties();
  const treasury = (await generateKeyPairSigner()).address;
  const split = {
    ...terms,
    splits: [
      { recipient: terms.payTo, bps: 9709 },
      { recipient: treasury, bps: 291 },
    ],
  };
  const authorization = await createUptoAuthorization(payer, split, hints);
  const verify = createUptoVerifier(feePayer.address, async () =>
    BigInt(hints.recentSlot),
  );
  assert.equal(await verify(authorization, split), true);
  // A seller expecting another distribution, or none, refuses the same open.
  for (const splits of [
    undefined,
    [{ recipient: terms.payTo, bps: 10_000 }],
    [
      { recipient: terms.payTo, bps: 9700 },
      { recipient: treasury, bps: 300 },
    ],
    [
      { recipient: terms.payTo, bps: 9709 },
      { recipient: feePayer.address, bps: 291 },
    ],
  ])
    assert.equal(
      await verify(authorization, { ...split, splits }),
      false,
      JSON.stringify(splits),
    );
});

void test('invalid distributions are refused before anything is signed', async () => {
  const { payer, terms, hints } = await parties();
  const treasury = (await generateKeyPairSigner()).address;
  for (const splits of [
    [{ recipient: treasury, bps: 10_000 }],
    [
      { recipient: terms.payTo, bps: 9000 },
      { recipient: treasury, bps: 500 },
    ],
    [],
  ])
    await assert.rejects(
      createUptoAuthorization(payer, { ...terms, splits }, hints),
    );
});
