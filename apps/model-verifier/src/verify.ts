import { createHash, randomBytes } from 'node:crypto';

import { renderChat } from '@gyblos/engine-ollama/model';
import {
  CONTROL_CODES,
  FREE_EXECUTION_CODES,
  type ControlCode,
  type FreeExecutionCode,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  MODEL_VERIFICATION,
  modelVerificationFailAt,
  modelVerificationVerdict,
  signModelVerification,
  type SignedModelVerification,
} from '@gyblos/protocol/model-verification';

import { challengeSetDigest, type ChallengeSet } from './challenge-set';
import {
  MODEL_VERIFIER_CODES,
  MODEL_VERIFIER_PHASES,
  SECRET_BYTES,
  SellerQuoteError,
  TEMPLATE_MARKER,
  type ModelVerifierCode,
} from './constants';
import type { VerifierKey } from './key';
import type { ReferenceModel } from './reference';
import { cutPoints, isDeviation, minimumLogprob } from './scoring';
import type { SellerTarget } from './seller';

export interface AnswerEvidence {
  challenge: number;
  prompt: string;
  text: string;
  digest: string;
  checks: { at: number; deviation: boolean }[];
}
interface UnscoredAnswerEvidence {
  challenge: number;
  phase: typeof MODEL_VERIFIER_PHASES.SCORING;
  prompt: string;
  text: string;
  digest: string;
  code: ModelVerifierCode;
}
interface SellerFailureEvidence {
  challenge: number;
  phase: (typeof MODEL_VERIFIER_PHASES)['QUOTE' | 'EXECUTION'];
  code: ModelVerifierCode | ControlCode | FreeExecutionCode;
}
export type UnscoredEvidence = UnscoredAnswerEvidence | SellerFailureEvidence;

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
  onAnswer?: (index: number, failure?: UnscoredEvidence['code']) => void;
}
export interface VerificationOutput {
  signed: SignedModelVerification;
  answers: AnswerEvidence[];
  unscored: UnscoredEvidence[];
}

const QUOTE_CODES = [
  ...Object.values(CONTROL_CODES),
  ...Object.values(MODEL_VERIFIER_CODES),
];
const EXECUTION_CODES = Object.values(FREE_EXECUTION_CODES);

function failureCode<T extends UnscoredEvidence['code']>(
  error: unknown,
  allowed: readonly T[],
) {
  const code: unknown =
    error && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value
      : undefined;
  return (
    allowed.find((candidate) => candidate === code) ??
    MODEL_VERIFIER_CODES.UNKNOWN
  );
}

function sellerFailure(
  challenge: number,
  error: unknown,
): SellerFailureEvidence {
  return error instanceof SellerQuoteError
    ? {
        challenge,
        phase: MODEL_VERIFIER_PHASES.QUOTE,
        code: failureCode(error.cause, QUOTE_CODES),
      }
    : {
        challenge,
        phase: MODEL_VERIFIER_PHASES.EXECUTION,
        code: failureCode(error, EXECUTION_CODES),
      };
}

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

async function scoreAnswer(
  input: VerificationInput,
  seed: string,
  challenge: number,
  prompt: string,
  text: string,
): Promise<AnswerEvidence> {
  const { rule } = input.set;
  const digest = sha256(text);
  const rendered = renderChat(prompt);
  const floor = minimumLogprob(rule.minProbabilityPpm);
  const checks: AnswerEvidence['checks'] = [];
  for (const at of cutPoints(text, rule.checksPerAnswer, `${seed}:${digest}`)) {
    const candidates = await input.reference.candidates(
      rendered + text.slice(0, at),
      rule.topLogprobs,
    );
    if (candidates)
      checks.push({
        at,
        deviation: isDeviation(text.slice(at), candidates, floor),
      });
  }
  return { challenge, prompt, text, digest, checks };
}

function evidenceOf(
  set: ChallengeSet,
  answers: readonly AnswerEvidence[],
  nonce: string,
) {
  const checks = answers.reduce((sum, answer) => sum + answer.checks.length, 0);
  const deviations = answers.reduce(
    (sum, answer) =>
      sum + answer.checks.filter((check) => check.deviation).length,
    0,
  );
  const deviantAnswers = answers.filter((answer) =>
    answer.checks.some((check) => check.deviation),
  ).length;
  return {
    prompts: set.prompts.length,
    answers: answers.length,
    checks,
    deviations,
    deviantAnswers,
    minimumChecks: set.rule.minimumChecks,
    honestRatePpm: set.rule.honestRatePpm,
    falsePositivePpm: set.rule.falsePositivePpm,
    failAt: modelVerificationFailAt(
      answers.length,
      set.rule.honestRatePpm,
      set.rule.falsePositivePpm,
    ),
    nonce,
    answerDigests: answers.map((answer) => answer.digest),
  };
}

export async function runVerification(
  input: VerificationInput,
): Promise<VerificationOutput> {
  const { set } = input;
  const setDigest = challengeSetDigest(set);
  const nonce = randomBytes(SECRET_BYTES).toString('hex');
  const answers: AnswerEvidence[] = [];
  const unscored: UnscoredEvidence[] = [];
  const skip = (
    index: number,
    prompt: string,
    text: string,
    code: ModelVerifierCode,
  ) => {
    unscored.push({
      challenge: index + 1,
      phase: MODEL_VERIFIER_PHASES.SCORING,
      prompt,
      text,
      digest: sha256(text),
      code,
    });
    input.onAnswer?.(index, code);
  };
  for (const [index, prompt] of set.prompts.entries()) {
    let text: string;
    try {
      text = await input.seller.ask(prompt, set.rule.maxTokens);
    } catch (error) {
      const failure = sellerFailure(index + 1, error);
      unscored.push(failure);
      input.onAnswer?.(index, failure.code);
      continue;
    }
    if (TEMPLATE_MARKER.test(text)) {
      skip(index, prompt, text, MODEL_VERIFIER_CODES.TEMPLATE_MARKER);
      continue;
    }
    const scored = await scoreAnswer(
      input,
      `${setDigest}:${nonce}`,
      index + 1,
      prompt,
      text,
    );
    if (!scored.checks.length) {
      skip(index, prompt, text, MODEL_VERIFIER_CODES.EMPTY_ANSWER);
      continue;
    }
    answers.push(scored);
    input.onAnswer?.(index);
  }
  await input.reference.confirm();
  const evidence = evidenceOf(set, answers, nonce);
  const signed = await signModelVerification(
    {
      schemaVersion: MODEL_VERIFICATION.schemaVersion,
      verifier: input.key.address,
      seller: { owner: input.target.owner, nodeId: input.target.nodeId },
      selection: input.seller.selection,
      challengeSet: { id: set.id, version: set.version, digest: setDigest },
      reference: { model: input.reference.tag, digest: input.reference.digest },
      evidence,
      verdict: modelVerificationVerdict(evidence),
      issuedAt: input.now(),
    },
    input.key.sign,
  );
  return { signed, answers, unscored };
}
