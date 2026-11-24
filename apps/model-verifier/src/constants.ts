export const PARTS_PER_MILLION = 1_000_000;

export const MODEL_VERIFIER = {
  defaultOllamaUrl: 'http://127.0.0.1:11434',
  referenceTimeoutMs: 120_000,
  answerTimeoutMs: 180_000,
  keyFileMode: 0o600,
  directoryMode: 0o700,
  resultFile: 'result.json',
  evidenceFile: 'evidence.json',
  maxSellerFileBytes: 16_384,
} as const;

export const MODEL_VERIFIER_COMMANDS = {
  VERIFY: 'verify',
  ADDRESS: 'address',
  CHECK: 'check',
} as const;

export const MODEL_VERIFIER_CODES = {
  USAGE: 'USAGE',
  UNSUPPORTED_MODEL: 'UNSUPPORTED_MODEL',
  REFERENCE_UNAVAILABLE: 'REFERENCE_UNAVAILABLE',
  NO_FREE_OFFER: 'NO_FREE_OFFER',
  INVALID_SELLER: 'INVALID_SELLER',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_RESULT: 'INVALID_RESULT',
} as const;

export type ModelVerifierCode =
  (typeof MODEL_VERIFIER_CODES)[keyof typeof MODEL_VERIFIER_CODES];

export class ModelVerifierError extends Error {
  constructor(readonly code: ModelVerifierCode) {
    super(code);
    this.name = 'ModelVerifierError';
  }
}
