// Owns laboratory types; product code must not depend on this module.
export type * from '@gyblos/payments-x402/accounting/types';

export type {
  ExactGateEvidence,
  ExactCaseResult,
} from './exact-evidence-types.js';

export type {
  InferenceGateEvidence,
  InferenceCaseResult,
  InferenceTrace,
} from './inference-evidence-types.js';

export type GateEvidence =
  | import('./exact-evidence-types.js').ExactGateEvidence
  | import('./inference-evidence-types.js').InferenceGateEvidence;

export type CaseResult =
  | import('./exact-evidence-types.js').ExactCaseResult
  | import('./inference-evidence-types.js').InferenceCaseResult;
