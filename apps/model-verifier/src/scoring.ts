import { createHash } from 'node:crypto';

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
  const match = [...candidates]
    .sort((left, right) => right.logprob - left.logprob)
    .find(({ token }) => token.length > 0 && rest.startsWith(token));
  return !match || match.logprob < minimumLogprob;
}

export function minimumLogprob(minProbabilityPpm: number) {
  return Math.log(minProbabilityPpm / PARTS_PER_MILLION);
}
