import { CONTROL_CODES, CONTROL_LIMITS } from './constants';
import { parseModelSelection } from './control-requests';
import type { ModelSelection } from './control-types';
import {
  controlAddress,
  controlArray,
  controlFail,
  controlHex,
  controlIdentifier,
  controlInteger,
  controlObject,
  controlVerify,
} from './control-validation';
import {
  MODEL_VERIFICATION,
  MODEL_VERIFICATION_VERDICTS,
  type ModelVerificationVerdict,
} from './model-verification/constants';
import { bytesHex, hexBytes, publicAddressBytes } from './public-validation';
import { sign, type Signer } from './signing';

export {
  MODEL_VERIFICATION,
  MODEL_VERIFICATION_VERDICTS,
  type ModelVerificationVerdict,
} from './model-verification/constants';

export interface ModelVerificationEvidence {
  prompts: number;
  answers: number;
  checks: number;
  deviations: number;
  deviantAnswers: number;
  minimumChecks: number;
  honestRatePpm: number;
  falsePositivePpm: number;
  failAt: number;
  nonce: string;
  answerDigests: string[];
}
export interface ModelVerificationV1 {
  schemaVersion: typeof MODEL_VERIFICATION.schemaVersion;
  verifier: string;
  seller: { owner: string; nodeId: string };
  selection: ModelSelection;
  challengeSet: { id: string; version: number; digest: string };
  reference: { model: string; digest: string };
  evidence: ModelVerificationEvidence;
  verdict: ModelVerificationVerdict;
  issuedAt: number;
}
export interface SignedModelVerification {
  result: ModelVerificationV1;
  signature: string;
}

const RESULT_KEYS = [
  'schemaVersion',
  'verifier',
  'seller',
  'selection',
  'challengeSet',
  'reference',
  'evidence',
  'verdict',
  'issuedAt',
] as const;

function parseVerdict(value: unknown): ModelVerificationVerdict {
  for (const verdict of Object.values(MODEL_VERIFICATION_VERDICTS))
    if (value === verdict) return verdict;
  return controlFail();
}

export function modelVerificationFailAt(
  answers: number,
  honestRatePpm: number,
  falsePositivePpm: number,
): number {
  const rate = honestRatePpm / MODEL_VERIFICATION.partsPerMillion;
  const alpha = falsePositivePpm / MODEL_VERIFICATION.partsPerMillion;
  let mass = (1 - rate) ** answers;
  let below = 0;
  for (let deviant = 0; deviant <= answers; deviant++) {
    if (1 - below <= alpha) return Math.max(deviant, 1);
    below += mass;
    mass *= ((answers - deviant) / (deviant + 1)) * (rate / (1 - rate));
  }
  return answers + 1;
}

export function modelVerificationVerdict(
  evidence: Pick<
    ModelVerificationEvidence,
    | 'prompts'
    | 'answers'
    | 'checks'
    | 'deviantAnswers'
    | 'minimumChecks'
    | 'failAt'
  >,
): ModelVerificationVerdict {
  if (evidence.deviantAnswers >= evidence.failAt)
    return MODEL_VERIFICATION_VERDICTS.FAIL;
  if (
    evidence.answers < evidence.prompts ||
    evidence.checks < evidence.minimumChecks
  )
    return MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE;
  return MODEL_VERIFICATION_VERDICTS.PASS;
}

const PPM_BELOW_ONE = MODEL_VERIFICATION.partsPerMillion - 1;

function parseEvidence(value: unknown): ModelVerificationEvidence {
  const input = controlObject(value, [
    'prompts',
    'answers',
    'checks',
    'deviations',
    'deviantAnswers',
    'minimumChecks',
    'honestRatePpm',
    'falsePositivePpm',
    'failAt',
    'nonce',
    'answerDigests',
  ]);
  const answerDigests = controlArray(
    input.answerDigests,
    MODEL_VERIFICATION.maxAnswers,
  ).map((digest) => controlHex(digest));
  const evidence = {
    prompts: controlInteger(input.prompts, 1, MODEL_VERIFICATION.maxAnswers),
    answers: controlInteger(input.answers, 0, MODEL_VERIFICATION.maxAnswers),
    checks: controlInteger(input.checks, 0, MODEL_VERIFICATION.maxChecks),
    deviations: controlInteger(input.deviations),
    deviantAnswers: controlInteger(input.deviantAnswers),
    minimumChecks: controlInteger(input.minimumChecks, 1),
    honestRatePpm: controlInteger(
      input.honestRatePpm,
      1,
      MODEL_VERIFICATION.maxHonestRatePpm,
    ),
    falsePositivePpm: controlInteger(input.falsePositivePpm, 1, PPM_BELOW_ONE),
    failAt: controlInteger(input.failAt, 1),
    nonce: controlHex(input.nonce, MODEL_VERIFICATION.nonceBytes),
    answerDigests,
  };
  if (
    evidence.answers !== answerDigests.length ||
    evidence.answers > evidence.prompts ||
    evidence.deviations > evidence.checks ||
    evidence.checks < evidence.answers ||
    evidence.checks - evidence.deviations <
      evidence.answers - evidence.deviantAnswers ||
    evidence.deviantAnswers > evidence.answers ||
    evidence.deviantAnswers > evidence.deviations ||
    (evidence.deviations > 0 && evidence.deviantAnswers === 0) ||
    evidence.failAt !==
      modelVerificationFailAt(
        evidence.answers,
        evidence.honestRatePpm,
        evidence.falsePositivePpm,
      )
  )
    return controlFail();
  return evidence;
}

export function parseModelVerification(value: unknown): ModelVerificationV1 {
  const input = controlObject(value, RESULT_KEYS);
  if (input.schemaVersion !== MODEL_VERIFICATION.schemaVersion)
    return controlFail(CONTROL_CODES.VERSION);
  const seller = controlObject(input.seller, ['owner', 'nodeId']);
  const challengeSet = controlObject(input.challengeSet, [
    'id',
    'version',
    'digest',
  ]);
  const reference = controlObject(input.reference, ['model', 'digest']);
  const evidence = parseEvidence(input.evidence);
  const verdict = parseVerdict(input.verdict);
  if (verdict !== modelVerificationVerdict(evidence)) return controlFail();
  return {
    schemaVersion: MODEL_VERIFICATION.schemaVersion,
    verifier: controlAddress(input.verifier),
    seller: {
      owner: controlAddress(seller.owner),
      nodeId: controlHex(seller.nodeId),
    },
    selection: parseModelSelection(input.selection),
    challengeSet: {
      id: controlIdentifier(challengeSet.id),
      version: controlInteger(challengeSet.version, 1),
      digest: controlHex(challengeSet.digest),
    },
    reference: {
      model: controlIdentifier(reference.model),
      digest: controlHex(reference.digest),
    },
    evidence,
    verdict,
    issuedAt: controlInteger(input.issuedAt),
  };
}

async function verifierSigned(
  result: ModelVerificationV1,
  signature: Uint8Array<ArrayBuffer>,
) {
  return controlVerify(
    MODEL_VERIFICATION.domain,
    result,
    publicAddressBytes(result.verifier),
    signature,
  );
}

export async function signModelVerification(
  value: ModelVerificationV1,
  signer: Signer,
): Promise<SignedModelVerification> {
  const result = parseModelVerification(value);
  const signature = Uint8Array.from(
    await sign(MODEL_VERIFICATION.domain, result, signer),
  );
  if (
    signature.length !== CONTROL_LIMITS.signatureBytes ||
    !(await verifierSigned(result, signature))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { result, signature: bytesHex(signature) };
}

export async function verifyModelVerification(
  value: unknown,
): Promise<SignedModelVerification> {
  const input = controlObject(value, ['result', 'signature']);
  const result = parseModelVerification(input.result);
  const signature = controlHex(input.signature, CONTROL_LIMITS.signatureBytes);
  if (!(await verifierSigned(result, hexBytes(signature))))
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { result, signature };
}
