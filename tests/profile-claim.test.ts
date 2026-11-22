import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import { IDENTITY_CLAIM } from '@gyblos/protocol/identity-claim';
import {
  parseProfileClaim,
  PROFILE_CLAIM,
  signProfileClaim,
  verifyProfileClaim,
  type ProfileClaimV1,
} from '@gyblos/protocol/profile-claim';
import { signingBytes } from '@gyblos/protocol/signing';

import { receiptSigner } from './support/receipt-fixture';

const T0 = 1_800_000_000_000;

function claim(nodeId: string, patch: Partial<ProfileClaimV1> = {}) {
  return {
    schemaVersion: PROFILE_CLAIM.schemaVersion,
    nodeId,
    name: 'Ada Lovelace',
    issuedAt: T0,
    ...patch,
  };
}
function fails(run: () => unknown, code: string = CONTROL_CODES.INVALID) {
  assert.throws(
    run,
    (error: unknown) => error instanceof ControlError && error.code === code,
  );
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ControlError && error.code === code,
  );
}
void test('a node signs a name and a clear, and both verify detached', async () => {
  const node = receiptSigner();
  for (const value of [
    claim(node.nodeId),
    claim(node.nodeId, { name: null }),
  ]) {
    const signed = await signProfileClaim(value, node.sign);
    const copy = structuredClone(signed);
    const verified = await verifyProfileClaim(copy);
    assert.deepEqual(verified, signed);
    copy.claim.issuedAt += 1;
    assert.equal(verified.claim.issuedAt, T0);
  }
});

void test('the profile parser refuses names that are not already normalized and malformed claims', () => {
  const nodeId = 'ab'.repeat(32);
  const bad: unknown[] = [
    claim(nodeId, { name: ' Ada' }),
    claim(nodeId, { name: 'Ada  Lovelace' }),
    claim(nodeId, { name: 'Ｌａｂ' }),
    claim(nodeId, { name: 'Cafe\u0301' }),
    claim(nodeId, { name: '' }),
    claim(nodeId, { name: 'Ada ✓' }),
    claim(nodeId, { name: 'Gyblos' }),
    claim('AB'.repeat(32)),
    claim('ab'.repeat(31)),
    claim(nodeId, { issuedAt: -1 }),
    claim(nodeId, { issuedAt: 1.5 }),
    { ...claim(nodeId), extra: 1 },
    (() => {
      const { name: _name, ...rest } = claim(nodeId);
      return rest;
    })(),
    null,
    [],
    'claim',
  ];
  for (const value of bad) fails(() => parseProfileClaim(value));
  fails(
    () => parseProfileClaim({ ...claim(nodeId), schemaVersion: 2 }),
    CONTROL_CODES.VERSION,
  );
});

void test('any change after signing, another key or another domain fails the profile signature', async () => {
  const node = receiptSigner();
  const other = receiptSigner();
  const signed = await signProfileClaim(claim(node.nodeId), node.sign);
  await rejects(
    verifyProfileClaim({
      ...signed,
      claim: { ...signed.claim, name: 'Ada Byron' },
    }),
    CONTROL_CODES.SIGNATURE,
  );
  await rejects(
    verifyProfileClaim({
      ...signed,
      claim: { ...signed.claim, nodeId: other.nodeId },
    }),
    CONTROL_CODES.SIGNATURE,
  );
  await rejects(
    signProfileClaim(claim(node.nodeId), other.sign),
    CONTROL_CODES.SIGNATURE,
  );
  const foreign = Buffer.from(
    await node.sign(signingBytes(IDENTITY_CLAIM.domain, signed.claim)),
  ).toString('hex');
  await rejects(
    verifyProfileClaim({ claim: signed.claim, signature: foreign }),
    CONTROL_CODES.SIGNATURE,
  );
  await rejects(
    verifyProfileClaim({ ...signed, extra: true }),
    CONTROL_CODES.INVALID,
  );
  await rejects(
    verifyProfileClaim({
      ...signed,
      signature: signed.signature.toUpperCase(),
    }),
    CONTROL_CODES.INVALID,
  );
  assert.notEqual(PROFILE_CLAIM.domain, IDENTITY_CLAIM.domain);
});

void test('profile claim vectors match independent canonical bytes and OpenSSL signatures', async () => {
  const data = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/profile-claim-v1.json'),
      ),
      'utf8',
    ),
  ) as { domain: string; cases: { signed: unknown; signingHex: string }[] };
  assert.equal(data.domain, PROFILE_CLAIM.domain);
  assert.equal(data.cases.length, 5);
  for (const vector of data.cases) {
    const signed = await verifyProfileClaim(vector.signed);
    assert.deepEqual(signed, vector.signed);
    const expected = Buffer.from(vector.signingHex, 'hex');
    assert.deepEqual(
      Buffer.from(signingBytes(PROFILE_CLAIM.domain, signed.claim)),
      expected,
    );
    const key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(signed.claim.nodeId, 'hex').toString('base64url'),
      },
      format: 'jwk',
    });
    assert.ok(
      verify(null, expected, key, Buffer.from(signed.signature, 'hex')),
    );
  }
});
