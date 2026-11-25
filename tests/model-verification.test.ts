import assert from 'node:assert/strict';
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { address, getAddressDecoder, getAddressEncoder } from '@solana/kit';

import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import {
  MODEL_VERIFICATION,
  MODEL_VERIFICATION_VERDICTS,
  modelVerificationFailAt,
  parseModelVerification,
  signModelVerification,
  verifyModelVerification,
  type ModelVerificationV1,
} from '@gyblos/protocol/model-verification';
import { signingBytes } from '@gyblos/protocol/signing';

const T0 = 1_800_000_000_000;
const DIGEST = 'cd'.repeat(32);
const RULE = {
  minimumChecks: 480,
  honestRatePpm: 50_000,
  falsePositivePpm: 100,
};
const digests = (count: number) => Array.from({ length: count }, () => DIGEST);

function verifierKey() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(
    pair.publicKey.export({ format: 'jwk' }).x!,
    'base64url',
  );
  return {
    address: getAddressDecoder().decode(publicKey),
    sign: async (bytes: Uint8Array) => sign(null, bytes, pair.privateKey),
  };
}

function result(
  verifier: string,
  patch: Partial<ModelVerificationV1> = {},
): ModelVerificationV1 {
  return {
    schemaVersion: MODEL_VERIFICATION.schemaVersion,
    verifier,
    seller: { owner: verifier, nodeId: 'ab'.repeat(32) },
    selection: { modelId: 'qwen3-1.7b', variant: null, quantization: null },
    challengeSet: { id: 'gyblos-text', version: 1, digest: DIGEST },
    reference: { model: 'qwen3:1.7b', digest: DIGEST },
    evidence: {
      prompts: 30,
      answers: 30,
      checks: 600,
      deviations: 0,
      deviantAnswers: 0,
      ...RULE,
      failAt: 8,
      nonce: DIGEST,
      answerDigests: digests(30),
    },
    verdict: MODEL_VERIFICATION_VERDICTS.PASS,
    issuedAt: T0,
    ...patch,
  };
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ControlError && error.code === code,
  );
}

void test('a verifier signs a result and it verifies detached', async () => {
  const key = verifierKey();
  const cases = [
    [MODEL_VERIFICATION_VERDICTS.PASS, 30, 600, 9, 7, 8],
    [MODEL_VERIFICATION_VERDICTS.FAIL, 30, 600, 12, 8, 8],
    [MODEL_VERIFICATION_VERDICTS.FAIL, 20, 400, 7, 7, 7],
    [MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE, 29, 580, 0, 0, 8],
    [MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE, 30, 479, 0, 0, 8],
  ] as const;
  for (const [verdict, answers, checks, deviations, deviant, failAt] of cases) {
    const value = result(key.address, {
      verdict,
      evidence: {
        prompts: 30,
        answers,
        checks,
        deviations,
        deviantAnswers: deviant,
        ...RULE,
        failAt,
        nonce: DIGEST,
        answerDigests: digests(answers),
      },
    });
    const signed = await signModelVerification(value, key.sign);
    const copy = structuredClone(signed);
    assert.deepEqual(await verifyModelVerification(copy), signed);
  }
});

void test('a changed result or another key fails the signature', async () => {
  const key = verifierKey();
  const signed = await signModelVerification(result(key.address), key.sign);
  const changed = structuredClone(signed);
  changed.result.evidence.checks += 1;
  await rejects(verifyModelVerification(changed), CONTROL_CODES.SIGNATURE);
  const other = verifierKey();
  await rejects(
    signModelVerification(result(key.address), other.sign),
    CONTROL_CODES.SIGNATURE,
  );
});

void test('the parser refuses a verdict its own evidence contradicts and malformed results', () => {
  const key = verifierKey();
  const evidence = result(key.address).evidence;
  const bad: unknown[] = [
    result(key.address, {
      evidence: { ...evidence, deviations: 8, deviantAnswers: 8 },
    }),
    result(key.address, {
      verdict: MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE,
      evidence: { ...evidence, deviations: 9, deviantAnswers: 9 },
    }),
    result(key.address, { verdict: MODEL_VERIFICATION_VERDICTS.FAIL }),
    result(key.address, { evidence: { ...evidence, answers: 29 } }),
    result(key.address, {
      evidence: { ...evidence, deviations: 0, deviantAnswers: 1 },
    }),
    result(key.address, {
      evidence: { ...evidence, deviations: 3, deviantAnswers: 0 },
    }),
    result(key.address, {
      evidence: { ...evidence, checks: 1, deviations: 2, deviantAnswers: 1 },
    }),
    result(key.address, { evidence: { ...evidence, failAt: 0 } }),
    result(key.address, { evidence: { ...evidence, failAt: 9 } }),
    result(key.address, { evidence: { ...evidence, prompts: 31 } }),
    result(key.address, {
      evidence: { ...evidence, honestRatePpm: 500_001, failAt: 31 },
    }),
    result(key.address, {
      evidence: { ...evidence, checks: 1_000_000 },
    }),
    result(key.address, {
      verdict: MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE,
      evidence: { ...evidence, checks: 29 },
    }),
    result(key.address, {
      evidence: {
        ...evidence,
        checks: 480,
        deviations: 470,
        deviantAnswers: 7,
      },
    }),
    result(key.address, { evidence: { ...evidence, nonce: 'ab' } }),
    result(key.address, { verdict: 'same' as never }),
    result(key.address, { verifier: 'ab'.repeat(32) }),
    { ...result(key.address), extra: true },
    null,
  ];
  for (const value of bad)
    assert.throws(
      () => parseModelVerification(value),
      (error: unknown) => error instanceof ControlError,
    );
  assert.throws(
    () => parseModelVerification({ ...result(key.address), schemaVersion: 2 }),
    (error: unknown) =>
      error instanceof ControlError && error.code === CONTROL_CODES.VERSION,
  );
});

void test('the failure threshold counts deviant answers, the independent unit', () => {
  assert.equal(modelVerificationFailAt(30, 50_000, 100), 8);
  assert.equal(modelVerificationFailAt(20, 50_000, 100), 7);
  assert.equal(modelVerificationFailAt(1, 50_000, 100), 2);
  assert.equal(modelVerificationFailAt(0, 50_000, 100), 1);
  assert.equal(modelVerificationFailAt(64, 500_000, 100), 48);
  assert.equal(modelVerificationFailAt(2, 120_000, 14_400), 2);
  assert.equal(modelVerificationFailAt(1, 120_000, 120_000), 1);
});

void test('golden vectors keep the model verification domain and canonical bytes', async () => {
  const data = JSON.parse(
    await readFile(
      new URL(
        import.meta
          .resolve('@gyblos/protocol/vectors/model-verification-v1.json'),
      ),
      'utf8',
    ),
  ) as { domain: string; cases: { signed: unknown; signingHex: string }[] };
  assert.equal(data.domain, MODEL_VERIFICATION.domain);
  assert.equal(data.cases.length, 3);
  for (const vector of data.cases) {
    const signed = await verifyModelVerification(vector.signed);
    assert.deepEqual(signed, vector.signed);
    const expected = Buffer.from(vector.signingHex, 'hex');
    assert.deepEqual(
      Buffer.from(signingBytes(MODEL_VERIFICATION.domain, signed.result)),
      expected,
    );
    const key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(
          getAddressEncoder().encode(address(signed.result.verifier)),
        ).toString('base64url'),
      },
      format: 'jwk',
    });
    assert.ok(
      verify(null, expected, key, Buffer.from(signed.signature, 'hex')),
    );
  }
});
