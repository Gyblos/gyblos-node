import { createHash } from 'node:crypto';

import { renderChat } from '@gyblos/engine-ollama/model';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  MODEL_VERIFICATION,
  signModelVerification,
  type SignedModelVerification,
} from '@gyblos/protocol/model-verification';

import { challengeSetDigest, type ChallengeSet } from './challenge-set';
import type { VerifierKey } from './key';
import type { ReferenceModel } from './reference';
import {
  cutPoints,
  failAt,
  isDeviation,
  minimumLogprob,
  verdictOf,
} from './scoring';
import type { SellerTarget } from './seller';

export interface AnswerEvidence {
  prompt: string;
  text: string;
  digest: string;
  checks: { at: number; deviation: boolean }[];
}
export interface VerifiedSeller {
  selection: ModelSelection;
  ask(prompt: string, maxTokens: number): Promise<string>;
}
export interface VerificationInput {
  target: SellerTarget;
  seller: VerifiedSeller;
  reference: ReferenceModel;
  set: ChallengeSet;
  key: VerifierKey;
  now: () => number;
  onAnswer?: (index: number, failure?: string) => void;
}

const UNKNOWN_FAILURE = 'UNKNOWN';
function failureCode(error: unknown) {
  const code =
    error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)
    ? code
    : UNKNOWN_FAILURE;
}

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

async function scoreAnswer(
  input: VerificationInput,
  setDigest: string,
  prompt: string,
  text: string,
): Promise<AnswerEvidence> {
  const { rule } = input.set;
  const digest = sha256(text);
  const rendered = renderChat(prompt);
  const floor = minimumLogprob(rule.minProbabilityPpm);
  const checks: AnswerEvidence['checks'] = [];
  for (const at of cutPoints(
    text,
    rule.checksPerAnswer,
    `${setDigest}:${digest}`,
  )) {
    const candidates = await input.reference.candidates(
      rendered + text.slice(0, at),
      rule.topLogprobs,
    );
    checks.push({
      at,
      deviation: isDeviation(text.slice(at), candidates, floor),
    });
  }
  return { prompt, text, digest, checks };
}

export async function runVerification(input: VerificationInput): Promise<{
  signed: SignedModelVerification;
  answers: AnswerEvidence[];
}> {
  const { set } = input;
  const setDigest = challengeSetDigest(set);
  const answers: AnswerEvidence[] = [];
  for (const [index, prompt] of set.prompts.entries()) {
    let text: string;
    try {
      text = await input.seller.ask(prompt, set.rule.maxTokens);
    } catch (error) {
      input.onAnswer?.(index, failureCode(error));
      continue;
    }
    answers.push(await scoreAnswer(input, setDigest, prompt, text));
    input.onAnswer?.(index);
  }
  const checks = answers.reduce((sum, answer) => sum + answer.checks.length, 0);
  const deviations = answers.reduce(
    (sum, answer) =>
      sum + answer.checks.filter((check) => check.deviation).length,
    0,
  );
  const threshold = failAt(
    checks,
    set.rule.honestRatePpm,
    set.rule.falsePositivePpm,
  );
  const signed = await signModelVerification(
    {
      schemaVersion: MODEL_VERIFICATION.schemaVersion,
      verifier: input.key.address,
      seller: { owner: input.target.owner, nodeId: input.target.nodeId },
      selection: input.seller.selection,
      challengeSet: { id: set.id, version: set.version, digest: setDigest },
      reference: { model: input.reference.tag, digest: input.reference.digest },
      evidence: {
        answers: answers.length,
        checks,
        deviations,
        failAt: threshold,
        answerDigests: answers.map((answer) => answer.digest),
      },
      verdict: verdictOf(checks, deviations, set.rule.minimumChecks, threshold),
      issuedAt: input.now(),
    },
    input.key.sign,
  );
  return { signed, answers };
}
