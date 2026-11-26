import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CHALLENGE_SET,
  challengeSetDigest,
} from '@gyblos/model-verifier/challenge-set';
import {
  MODEL_VERIFIER_CODES,
  MODEL_VERIFIER_COMMANDS,
  ModelVerifierError,
} from '@gyblos/model-verifier/constants';
import { loadVerifierKey } from '@gyblos/model-verifier/key';
import { main } from '@gyblos/model-verifier/main';
import { parseSellerTarget } from '@gyblos/model-verifier/seller';
import { MODEL_IDS } from '@gyblos/protocol';
import {
  MODEL_VERIFICATION,
  modelVerificationFailAt,
  modelVerificationVerdict,
  signModelVerification,
} from '@gyblos/protocol/model-verification';

const TARGET = {
  owner: '2nc4a8RxZMdWMMyBxAeKcT22HpAs5c3zgSTXnvYZ2L9S',
  nodeId: 'ab'.repeat(32),
  relayUrl: null,
  directAddresses: ['127.0.0.1:4433'],
};

function isCode(code: string) {
  return (error: unknown) =>
    error instanceof ModelVerifierError && error.code === code;
}

async function withHome<T>(run: (home: string) => Promise<T>) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-'));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

void test('a seller target is parsed strictly', () => {
  assert.deepEqual(parseSellerTarget(TARGET), TARGET);
  for (const value of [
    { ...TARGET, owner: 'not-an-address' },
    { ...TARGET, nodeId: 'AB'.repeat(32) },
    { ...TARGET, directAddresses: 'x' },
    { ...TARGET, extra: true },
    null,
  ])
    assert.throws(
      () => parseSellerTarget(value),
      isCode(MODEL_VERIFIER_CODES.INVALID_SELLER),
    );
});

void test('the verifier key is created once, private, and refused when missing or corrupt', async () => {
  await withHome(async (home) => {
    const path = join(home, 'nested', 'verifier.key');
    await assert.rejects(
      loadVerifierKey(path, false),
      isCode(MODEL_VERIFIER_CODES.INVALID_KEY),
    );
    const first = await loadVerifierKey(path, true);
    const again = await loadVerifierKey(path, false);
    assert.equal(again.address, first.address);
    if (process.platform !== 'win32')
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    const corrupt = join(home, 'corrupt.key');
    for (const text of ['{"seed":"zz"}\n', 'not json\n']) {
      await writeFile(corrupt, text, { mode: 0o600 });
      await assert.rejects(
        loadVerifierKey(corrupt, false),
        isCode(MODEL_VERIFIER_CODES.INVALID_KEY),
      );
    }
  });
});

const { prompts, rule } = CHALLENGE_SET;
const evidenceCases = [
  [
    'accepts counts at both published limits',
    prompts.length,
    0,
    1,
    rule.checksPerAnswer,
    0,
  ],
  ['rejects one check above the full maximum', prompts.length, 1, 0, 0, 1],
  [
    'rejects one check above the maximum for the answered prompts',
    prompts.length - 1,
    1,
    0,
    0,
    1,
  ],
  [
    'rejects one deviation above the maximum for one deviant answer',
    prompts.length,
    0,
    1,
    rule.checksPerAnswer + 1,
    1,
  ],
  [
    'accepts deviations at the maximum for two deviant answers',
    prompts.length,
    0,
    2,
    2 * rule.checksPerAnswer,
    0,
  ],
  [
    'rejects one deviation above the maximum for two deviant answers',
    prompts.length,
    0,
    2,
    2 * rule.checksPerAnswer + 1,
    1,
  ],
  ['accepts a partial run at its own maximum', prompts.length - 1, 0, 0, 0, 0],
] as const;

for (const [
  name,
  answers,
  extraChecks,
  deviantAnswers,
  deviations,
  exitCode,
] of evidenceCases) {
  void test(`check ${name}`, async (context) => {
    await withHome(async (home) => {
      const key = await loadVerifierKey(join(home, 'verifier.key'), true);
      const digest = 'cd'.repeat(32);
      const { minimumChecks, honestRatePpm, falsePositivePpm } = rule;
      const evidence = {
        prompts: prompts.length,
        answers,
        checks: answers * rule.checksPerAnswer + extraChecks,
        deviations,
        deviantAnswers,
        minimumChecks,
        honestRatePpm,
        falsePositivePpm,
        failAt: modelVerificationFailAt(
          answers,
          honestRatePpm,
          falsePositivePpm,
        ),
        nonce: 'ab'.repeat(MODEL_VERIFICATION.nonceBytes),
        answerDigests: Array.from({ length: answers }, () => digest),
      };
      const { id, version } = CHALLENGE_SET;
      const signed = await signModelVerification(
        {
          schemaVersion: MODEL_VERIFICATION.schemaVersion,
          verifier: key.address,
          seller: { owner: TARGET.owner, nodeId: TARGET.nodeId },
          selection: {
            modelId: MODEL_IDS.QWEN3_1_7B,
            variant: null,
            quantization: null,
          },
          challengeSet: {
            id,
            version,
            digest: challengeSetDigest(CHALLENGE_SET),
          },
          reference: { model: 'qwen3:1.7b', digest },
          evidence,
          verdict: modelVerificationVerdict(evidence),
          issuedAt: 1_800_000_000_000,
        },
        key.sign,
      );
      const resultFile = join(home, 'result.json');
      await writeFile(resultFile, JSON.stringify(signed));
      const reportError = context.mock.method(console, 'error', () => {});
      assert.equal(
        await main([MODEL_VERIFIER_COMMANDS.CHECK, resultFile]),
        exitCode,
      );
      if (exitCode === 1)
        assert.deepEqual(
          reportError.mock.calls.map((call) => call.arguments),
          [
            [
              JSON.stringify({
                ok: false,
                code: MODEL_VERIFIER_CODES.INVALID_RESULT,
              }),
            ],
          ],
        );
    });
  });
}
