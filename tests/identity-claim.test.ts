// Protects the signed identity claim v1: a strict, detaching parser (exact keys, lowercase GitHub login
// and gist id, both null or both set), the node signature under its own domain, the proof line and the
// independent golden vectors. Synthetic ephemeral keys only.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import {
  githubProofLine,
  IDENTITY_CLAIM,
  IDENTITY_CLAIM_KINDS,
  parseIdentityClaim,
  signIdentityClaim,
  verifyIdentityClaim,
  type IdentityClaimV1,
} from '@gyblos/protocol/identity-claim';
import { OBSERVATION_UPLOAD } from '@gyblos/protocol/observation-upload';
import { signingBytes } from '@gyblos/protocol/signing';

import { receiptSigner } from './support/receipt-fixture';

const T0 = 1_800_000_000_000;
const GIST = '0123456789abcdef0123456789abcdef';

function claim(nodeId: string, patch: Partial<IdentityClaimV1> = {}) {
  return {
    schemaVersion: IDENTITY_CLAIM.schemaVersion,
    kind: IDENTITY_CLAIM_KINDS.GITHUB,
    nodeId,
    account: 'octo-cat',
    gist: GIST,
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

void test('a node signs a GitHub claim and a cancel, and both verify detached', async () => {
  const node = receiptSigner();
  for (const value of [
    claim(node.nodeId),
    claim(node.nodeId, { account: null, gist: null }),
  ]) {
    const signed = await signIdentityClaim(value, node.sign);
    const copy = structuredClone(signed);
    const verified = await verifyIdentityClaim(copy);
    assert.deepEqual(verified, signed);
    copy.claim.issuedAt += 1;
    assert.equal(verified.claim.issuedAt, T0);
  }
});

void test('the parser accepts GitHub login and gist id bounds', () => {
  const nodeId = 'ab'.repeat(32);
  for (const account of [
    'a',
    '0',
    'a-b-c',
    'x'.repeat(39),
    'a1-2b',
    `a${'-b'.repeat(19)}`,
  ])
    assert.equal(
      parseIdentityClaim(claim(nodeId, { account })).account,
      account,
    );
  for (const gist of ['a'.repeat(20), 'f'.repeat(32)])
    assert.equal(parseIdentityClaim(claim(nodeId, { gist })).gist, gist);
});

void test('the parser refuses malformed accounts, gists, keys and half cancels', () => {
  const nodeId = 'ab'.repeat(32);
  const bad: unknown[] = [
    ...[
      '',
      'Octo',
      '-a',
      'a-',
      'a--b',
      'x'.repeat(40),
      `a${'-b'.repeat(38)}`,
      `ab${'-b'.repeat(19)}`,
      'a_b',
      'a.b',
      ' a',
    ].map((account) => claim(nodeId, { account })),
    ...[
      'a'.repeat(19),
      'a'.repeat(33),
      'ABCDEF0123456789ABCD',
      `${GIST}\n`,
    ].map((gist) => claim(nodeId, { gist })),
    claim(nodeId, { account: null }),
    claim(nodeId, { gist: null }),
    claim('AB'.repeat(32)),
    claim('ab'.repeat(31)),
    claim(nodeId, { issuedAt: -1 }),
    claim(nodeId, { issuedAt: 1.5 }),
    { ...claim(nodeId), kind: 'gitlab' },
    { ...claim(nodeId), extra: 1 },
    (() => {
      const { gist: _gist, ...rest } = claim(nodeId);
      return rest;
    })(),
    null,
    [],
    'claim',
  ];
  for (const value of bad) fails(() => parseIdentityClaim(value));
  fails(
    () => parseIdentityClaim({ ...claim(nodeId), schemaVersion: 2 }),
    CONTROL_CODES.VERSION,
  );
});

void test('any change after signing, another key or another domain fails the signature', async () => {
  const node = receiptSigner();
  const other = receiptSigner();
  const signed = await signIdentityClaim(claim(node.nodeId), node.sign);
  await rejects(
    verifyIdentityClaim({
      ...signed,
      claim: { ...signed.claim, account: 'octo-dog' },
    }),
    CONTROL_CODES.SIGNATURE,
  );
  await rejects(
    verifyIdentityClaim({
      ...signed,
      claim: { ...signed.claim, nodeId: other.nodeId },
    }),
    CONTROL_CODES.SIGNATURE,
  );
  await rejects(
    signIdentityClaim(claim(node.nodeId), other.sign),
    CONTROL_CODES.SIGNATURE,
  );
  const foreign = Buffer.from(
    await node.sign(signingBytes(OBSERVATION_UPLOAD.domain, signed.claim)),
  ).toString('hex');
  await rejects(
    verifyIdentityClaim({ claim: signed.claim, signature: foreign }),
    CONTROL_CODES.SIGNATURE,
  );
  await rejects(
    verifyIdentityClaim({ ...signed, extra: true }),
    CONTROL_CODES.INVALID,
  );
  await rejects(
    verifyIdentityClaim({
      ...signed,
      signature: signed.signature.toUpperCase(),
    }),
    CONTROL_CODES.INVALID,
  );
});

void test('the proof line is the prefix and the NodeId, and refuses a malformed NodeId', () => {
  const nodeId = 'ab'.repeat(32);
  assert.equal(githubProofLine(nodeId), `gyblos-node=${nodeId}`);
  fails(() => githubProofLine('AB'.repeat(32)));
});

void test('identity claim vectors match independent canonical bytes and OpenSSL signatures', async () => {
  const data = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/identity-claim-v1.json'),
      ),
      'utf8',
    ),
  ) as { domain: string; cases: { signed: unknown; signingHex: string }[] };
  assert.equal(data.domain, IDENTITY_CLAIM.domain);
  assert.equal(data.cases.length, 3);
  for (const vector of data.cases) {
    const signed = await verifyIdentityClaim(vector.signed);
    assert.deepEqual(signed, vector.signed);
    const expected = Buffer.from(vector.signingHex, 'hex');
    assert.deepEqual(
      Buffer.from(signingBytes(IDENTITY_CLAIM.domain, signed.claim)),
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
