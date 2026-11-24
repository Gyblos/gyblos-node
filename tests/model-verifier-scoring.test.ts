import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHALLENGE_SET,
  challengeSetDigest,
} from '@gyblos/model-verifier/challenge-set';
import { cutPoints, isDeviation } from '@gyblos/model-verifier/scoring';

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

void test('the deviation check does not depend on the order candidates arrive in', () => {
  const minimum = Math.log(1e-3);
  const sorted = [
    { token: ' then', logprob: -0.1 },
    { token: ' the', logprob: -9 },
  ];
  const reversed = [...sorted].reverse();
  for (const rest of [' then x', ' the cat', ' thermal'])
    assert.equal(
      isDeviation(rest, reversed, minimum),
      isDeviation(rest, sorted, minimum),
      rest,
    );
  assert.equal(isDeviation(' the cat', reversed, minimum), true);
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
