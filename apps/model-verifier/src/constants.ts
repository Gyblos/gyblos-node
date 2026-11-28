export const SECRET_BYTES = 32;
export const MAX_DIRECT_ADDRESSES = 16;
export const FREE_ATOMIC = '0';
export const TEMPLATE_MARKER = /<\|[A-Za-z0-9_]+\|>/;

export const MODEL_VERIFIER = {
  defaultOllamaUrl: 'http://127.0.0.1:11434',
  referenceTimeoutMs: 120_000,
  referenceAttempts: 3,
  referenceRetryMs: 3_000,
  referenceMaxResponseBytes: 1_048_576,
  answerTimeoutMs: 180_000,
  directoryMode: 0o700,
  stagingPrefix: '.verification-',
  resultFile: 'result.json',
  evidenceFile: 'evidence.json',
  maxSellerFileBytes: 16_384,
  privateFileMode: 0o600,
} as const;

export const MODEL_VERIFIER_COMMANDS = {
  VERIFY: 'verify',
  ADDRESS: 'address',
  CHECK: 'check',
} as const;

export const MODEL_VERIFIER_PHASES = {
  QUOTE: 'quote',
  EXECUTION: 'execution',
  SCORING: 'scoring',
} as const;

export const MODEL_VERIFIER_OUTPUT_DIAGNOSTICS = {
  component: 'model-verifier',
  operation: 'publish-output',
  phases: { cleanup: 'cleanup' },
} as const;

export const MODEL_VERIFIER_CODES = {
  USAGE: 'USAGE',
  UNSUPPORTED_MODEL: 'UNSUPPORTED_MODEL',
  REFERENCE_UNAVAILABLE: 'REFERENCE_UNAVAILABLE',
  REFERENCE_CHANGED: 'REFERENCE_CHANGED',
  REMOTE_REFERENCE: 'REMOTE_REFERENCE',
  NO_FREE_OFFER: 'NO_FREE_OFFER',
  INVALID_SELLER: 'INVALID_SELLER',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_RESULT: 'INVALID_RESULT',
  TEMPLATE_MARKER: 'TEMPLATE_MARKER',
  EMPTY_ANSWER: 'EMPTY_ANSWER',
  OUTPUT_LIMIT: 'OUTPUT_LIMIT',
  TOKENIZER_UNAVAILABLE: 'TOKENIZER_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
  INTERNAL: 'INTERNAL',
  OUTPUT_EXISTS: 'OUTPUT_EXISTS',
  OUTPUT_CLEANUP_FAILED: 'OUTPUT_CLEANUP_FAILED',
} as const;

export type ModelVerifierCode =
  (typeof MODEL_VERIFIER_CODES)[keyof typeof MODEL_VERIFIER_CODES];

export class ModelVerifierError extends Error {
  constructor(readonly code: ModelVerifierCode) {
    super(code);
    this.name = 'ModelVerifierError';
  }
}

export class SellerQuoteError extends Error {
  constructor(cause: unknown) {
    super(MODEL_VERIFIER_PHASES.QUOTE, { cause });
  }
}
