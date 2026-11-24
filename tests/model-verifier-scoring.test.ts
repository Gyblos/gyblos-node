import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHALLENGE_SET,
  challengeSetDigest,
} from '@gyblos/model-verifier/challenge-set';
import {
  cutPoints,
  failAt,
  isDeviation,
  verdictOf,
} from '@gyblos/model-verifier/scoring';
import { MODEL_VERIFICATION_VERDICTS } from '@gyblos/protocol/model-verification';

const PPM = 1_000_000;

void test('cut points fall just before a word and are a stable, bounded subset', () => {
  const text =
    'The sea  breathes, life through its tides. 42 currents\nand mystery';
  const all = cutPoints(text, 100, 'seed');
  for (const at of all) {
    assert.equal(text[at], ' ');
    assert.match(text[at + 1]!, /[\p{L}\p{N}]/u);
    assert.doesNotMatch(text[at - 1]!, /\s/);
  }
  assert.deepEqual(all, [3, 18, 23, 31, 35, 42, 45, 58]);
  const some = cutPoints(text, 3, 'seed');
  assert.equal(some.length, 3);
  assert.deepEqual(some, cutPoints(text, 3, 'seed'));
  assert.ok(some.every((at, index) => index === 0 || at > some[index - 1]!));
  assert.ok(some.every((at) => all.includes(at)));
  assert.deepEqual(cutPoints('', 5, 'seed'), []);
});

void test('a deviation is a continuation the reference ranks out or finds improbable', () => {
  const minimum = Math.log(1e-3);
  const candidates = [
    { token: ' of', logprob: -0.1 },
    { token: ' city', logprob: -5 },
    { token: ' o', logprob: -8 },
  ];
  assert.equal(isDeviation(' of France', candidates, minimum), false);
  assert.equal(isDeviation(' city hall', candidates, minimum), false);
  assert.equal(isDeviation(' old town', candidates, minimum), true);
  assert.equal(isDeviation(' Paris', candidates, minimum), true);
  assert.equal(isDeviation(' of', [{ token: '', logprob: 0 }], minimum), true);
  assert.equal(isDeviation(' of', [], minimum), true);
});

void test('the failure threshold keeps the false positive bound and grows with the checks', () => {
  const rate = 5_000;
  const alpha = 100;
  const tail = (n: number, k: number) => {
    let total = 0;
    for (let x = k; x <= n; x++) {
      let term = 1;
      for (let i = 0; i < x; i++) term *= ((n - i) / (i + 1)) * (rate / PPM);
      total += term * (1 - rate / PPM) ** (n - x);
    }
    return total;
  };
  for (const checks of [24, 480, 720]) {
    const k = failAt(checks, rate, alpha);
    assert.ok(tail(checks, k) <= alpha / PPM);
    assert.ok(k === 1 || tail(checks, k - 1) > alpha / PPM);
  }
  assert.equal(failAt(720, rate, alpha), 13);
  assert.equal(failAt(480, rate, alpha), 11);
});

void test('the verdict fails on enough deviations, otherwise passes only with enough checks', () => {
  assert.equal(verdictOf(720, 13, 480, 13), MODEL_VERIFICATION_VERDICTS.FAIL);
  assert.equal(verdictOf(720, 12, 480, 13), MODEL_VERIFICATION_VERDICTS.PASS);
  assert.equal(
    verdictOf(100, 0, 480, 5),
    MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE,
  );
  assert.equal(verdictOf(100, 9, 480, 5), MODEL_VERIFICATION_VERDICTS.FAIL);
});

void test('the challenge set is versioned and its digest covers prompts and rule', () => {
  assert.equal(CHALLENGE_SET.version, 1);
  assert.ok(CHALLENGE_SET.prompts.length >= 20);
  assert.match(challengeSetDigest(CHALLENGE_SET), /^[0-9a-f]{64}$/);
  assert.notEqual(
    challengeSetDigest({
      ...CHALLENGE_SET,
      rule: { ...CHALLENGE_SET.rule, minimumChecks: 1 },
    }),
    challengeSetDigest(CHALLENGE_SET),
  );
});
