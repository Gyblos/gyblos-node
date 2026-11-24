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
  answers: number;
  checks: number;
  deviations: number;
  failAt: number;
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

function parseEvidence(value: unknown): ModelVerificationEvidence {
  const input = controlObject(value, [
    'answers',
    'checks',
    'deviations',
    'failAt',
    'answerDigests',
  ]);
  const answerDigests = controlArray(
    input.answerDigests,
    MODEL_VERIFICATION.maxAnswers,
  ).map((digest) => controlHex(digest));
  const evidence = {
    answers: controlInteger(input.answers, 0, MODEL_VERIFICATION.maxAnswers),
    checks: controlInteger(input.checks),
    deviations: controlInteger(input.deviations),
    failAt: controlInteger(input.failAt, 1),
    answerDigests,
  };
  if (
    evidence.answers !== answerDigests.length ||
    evidence.deviations > evidence.checks
  )
    return controlFail();
  return evidence;
}

function consistentVerdict(
  evidence: ModelVerificationEvidence,
  verdict: ModelVerificationVerdict,
) {
  const failed = evidence.deviations >= evidence.failAt;
  if (verdict === MODEL_VERIFICATION_VERDICTS.FAIL) return failed;
  return !failed;
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
  if (!consistentVerdict(evidence, verdict)) return controlFail();
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
