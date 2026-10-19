import type { GateErrorCode } from '@gyblos/payments-x402/constants';

export const EXACT_EVIDENCE_CODES = {
  GATE_ERROR: 'GATE_ERROR',
} as const;

export const INFERENCE_EVIDENCE_CODES = {
  ASSERTION_FAILED: 'ASSERTION_FAILED',
  EXECUTION_INTERRUPTED_OR_UNKNOWN: 'EXECUTION_INTERRUPTED_OR_UNKNOWN',
} as const;

export type ExactEvidenceErrorCode =
  | GateErrorCode
  | (typeof EXACT_EVIDENCE_CODES)[keyof typeof EXACT_EVIDENCE_CODES];

export type InferenceEvidenceErrorCode =
  | GateErrorCode
  | (typeof INFERENCE_EVIDENCE_CODES)[keyof typeof INFERENCE_EVIDENCE_CODES];
