export const MODEL_VERIFICATION = {
  schemaVersion: 1,
  domain: 'gyblos/model-verification/v1\n',
  maxAnswers: 64,
} as const;

export const MODEL_VERIFICATION_VERDICTS = {
  PASS: 'pass',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive',
} as const;

export type ModelVerificationVerdict =
  (typeof MODEL_VERIFICATION_VERDICTS)[keyof typeof MODEL_VERIFICATION_VERDICTS];
