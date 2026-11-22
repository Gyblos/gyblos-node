import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import { IDENTITY_CLAIM } from '@gyblos/protocol/identity-claim';
import {
  parseProfileClaim,
  parseSellerName,
  PROFILE_CLAIM,
  SELLER_NAME_ISSUES,
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
const accepted = (input: string) => {
  const result = parseSellerName(input);
  assert.ok(result.ok, `expected ${JSON.stringify(input)} to be accepted`);
  return result.name;
};
const issueOf = (input: unknown) => {
  const result = parseSellerName(input);
  assert.ok(!result.ok, `expected ${JSON.stringify(input)} to be refused`);
  return result.issue;
};

void test('a seller name is NFKC-normalized, trimmed and its inner spaces collapsed', () => {
  assert.equal(accepted('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(accepted('Ada\u00a0Lovelace'), 'Ada Lovelace');
  assert.equal(accepted('Ada\u3000Lovelace'), 'Ada Lovelace');
  assert.equal(accepted('Ｌａｂ\u3000４２'), 'Lab 42');
  assert.equal(accepted('Cafe\u0301'), 'Café');
  assert.equal(accepted('ﬁne'), 'fine');
  assert.equal(accepted('node①'), 'node1');
});

void test('a seller name keeps letters and numbers of any script and the allowed punctuation', () => {
  for (const name of [
    'a',
    '7',
    "O'Brien",
    'node_01',
    'east-1.lab',
    'Zoë Ñúñez',
    '東京ノード',
    'Москва',
    'محمد',
    'שלום',
    'x'.repeat(PROFILE_CLAIM.maxNameCharacters),
    '東'.repeat(PROFILE_CLAIM.maxNameCharacters),
    '𝒜'.repeat(PROFILE_CLAIM.maxNameCharacters),
  ])
    assert.equal(accepted(name), name.normalize('NFKC'));
});

void test('a seller name outside 1 to 32 characters is refused', () => {
  for (const input of [
    '',
    '   ',
    '\u3000',
    'x'.repeat(PROFILE_CLAIM.maxNameCharacters + 1),
    '東'.repeat(PROFILE_CLAIM.maxNameCharacters + 1),
    'x'.repeat(PROFILE_CLAIM.maxInputCharacters + 1),
  ])
    assert.equal(issueOf(input), SELLER_NAME_ISSUES.LENGTH, input);
});

void test('check marks, emoji, symbols, controls and invisible characters are refused', () => {
  for (const input of [
    'Ada ✓',
    'Ada ✔',
    '✅ Ada',
    '☑ Ada',
    '✓',
    'Ada 😀',
    'Ada 👍🏽',
    '🇺🇸 Ada',
    '1\ufe0f\u20e3 Ada',
    'Ada ♥',
    'Ada √',
    'Ada ©',
    'Ada $',
    'Ada @home',
    'Ada/Lab',
    'Ada <b>',
    'Ada\u0338',
    'Ada\u20dd',
    'Ada\u202eabc',
    'Ada\u202d',
    'Ada\u2066x\u2069',
    'Ada\u200f',
    'Ada\u061c',
    'Ad\u200ba',
    'Ad\u200da',
    'Ad\u00ada',
    'Ad\ufeffa',
    'Ad\u2060a',
    'Ada\ufe0f',
    'Ada\u3164',
    '\u3164',
    'Ada\u115f',
    'Ada\uffa0',
    'Ada\tLab',
    'Ada\nLab',
    'Ada\rLab',
    'Ada\u0000',
    'Ada\u007f',
    'Ada\u0085',
    'Ada\u2028Lab',
    'Ada\u2029Lab',
    'Ada\ue000',
    'Ada\ud800',
    'Ada’s',
    '-',
    '...',
    "' _ '",
  ])
    assert.equal(
      issueOf(input),
      SELLER_NAME_ISSUES.CHARACTERS,
      JSON.stringify(input),
    );
});

void test('a seller name containing the reserved word is refused in any case or width', () => {
  for (const input of [
    'gyblos',
    'Gyblos',
    'GYBLOS',
    'gYbLoS',
    'Gyblos Official',
    'the gyblos team',
    'mygyblosnode',
    'Ｇｙｂｌｏｓ',
    'gyblos_1',
  ])
    assert.equal(issueOf(input), SELLER_NAME_ISSUES.RESERVED, input);
  assert.equal(accepted('Gyb los'), 'Gyb los');
});

void test('a seller name that is not a string is refused', () => {
  for (const input of [null, undefined, 42, ['Ada'], { name: 'Ada' }])
    assert.equal(issueOf(input), SELLER_NAME_ISSUES.CHARACTERS);
});

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
  assert.equal(data.cases.length, 3);
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
