export type * from '@gyblos/payments-x402/accounting/types';

export type {
  ExactGateEvidence,
  ExactCaseResult,
} from '@gyblos/lab-harness/exact-evidence-types';

export type {
  InferenceGateEvidence,
  InferenceCaseResult,
  InferenceTrace,
} from '@gyblos/lab-harness/inference-evidence-types';

export type GateEvidence =
  | import('@gyblos/lab-harness/exact-evidence-types').ExactGateEvidence
  | import('@gyblos/lab-harness/inference-evidence-types').InferenceGateEvidence;

export type CaseResult =
  | import('@gyblos/lab-harness/exact-evidence-types').ExactCaseResult
  | import('@gyblos/lab-harness/inference-evidence-types').InferenceCaseResult;
