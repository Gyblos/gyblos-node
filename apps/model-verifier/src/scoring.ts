import { createHash } from 'node:crypto';

import {
  MODEL_VERIFICATION_VERDICTS,
  type ModelVerificationVerdict,
} from '@gyblos/protocol/model-verification';

import { PARTS_PER_MILLION } from './constants';

export interface Candidate {
  token: string;
  logprob: number;
}

const WORD_START = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function order(seed: string, at: number) {
  return createHash('sha256').update(`${seed}:${at}`).digest('hex');
}

export function cutPoints(text: string, limit: number, seed: string): number[] {
  const points: number[] = [];
  for (let at = 1; at < text.length - 1; at++)
    if (
      text[at] === ' ' &&
      WORD_START.test(text[at + 1]!) &&
      !SPACE.test(text[at - 1]!)
    )
      points.push(at);
  return points
    .map((at) => ({ at, key: order(seed, at) }))
    .sort((left, right) => (left.key < right.key ? -1 : 1))
    .slice(0, limit)
    .map(({ at }) => at)
    .sort((left, right) => left - right);
}

export function isDeviation(
  rest: string,
  candidates: readonly Candidate[],
  minimumLogprob: number,
): boolean {
  const match = candidates.find(
    ({ token }) => token.length > 0 && rest.startsWith(token),
  );
  return !match || match.logprob < minimumLogprob;
}

export function minimumLogprob(minProbabilityPpm: number) {
  return Math.log(minProbabilityPpm / PARTS_PER_MILLION);
}

export function failAt(
  checks: number,
  honestRatePpm: number,
  falsePositivePpm: number,
): number {
  const rate = honestRatePpm / PARTS_PER_MILLION;
  const alpha = falsePositivePpm / PARTS_PER_MILLION;
  let mass = (1 - rate) ** checks;
  let below = 0;
  for (let deviations = 0; deviations <= checks; deviations++) {
    if (1 - below <= alpha) return Math.max(deviations, 1);
    below += mass;
    mass *= ((checks - deviations) / (deviations + 1)) * (rate / (1 - rate));
  }
  return checks + 1;
}

export function verdictOf(
  checks: number,
  deviations: number,
  minimumChecks: number,
  threshold: number,
): ModelVerificationVerdict {
  if (deviations >= threshold) return MODEL_VERIFICATION_VERDICTS.FAIL;
  if (checks < minimumChecks) return MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE;
  return MODEL_VERIFICATION_VERDICTS.PASS;
}
