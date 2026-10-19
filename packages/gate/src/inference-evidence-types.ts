import type { PRICES, TOLERANCE } from '@gyblos/application/metering';
import type { EngineUsage, MODEL } from '@gyblos/inference-ollama/index';

import type { inferenceSnapshot, transactionTransfers } from './chain.js';
import type { InferenceEvidenceErrorCode } from './constants.js';
import type { EvidenceBase } from './evidence-types.js';
import type { Measurement } from './measurements.js';

export type InferenceSnapshot = Awaited<ReturnType<typeof inferenceSnapshot>>;

export interface InferenceTrace {
  channelId: string;
  depositConfirmedAt: string;
  engineStartedAt: string;
  during: InferenceSnapshot;
  firstFragmentAt?: string;
  stoppedAt?: string;
  stoppedSignal?: string;
}

export interface InferenceTransaction {
  signature: string;
  slot: number;
  transfers: ReturnType<typeof transactionTransfers>;
}

export interface InferenceCaseResult {
  case: string;
  measurement: Measurement;
  before: InferenceSnapshot;
  duringDeposit: InferenceSnapshot;
  after: InferenceSnapshot;
  trace: InferenceTrace;
  refundAtomic: string;
  engineUsage: EngineUsage | null;
  doneReason: string | null;
  onChain: { open: InferenceTransaction; claim: InferenceTransaction };
}

export interface InferenceGateEvidence extends EvidenceBase {
  createdAt: string;
  runId: string;
  model: typeof MODEL;
  prices: typeof PRICES;
  tolerance: typeof TOLERANCE;
  template: {
    raw: boolean;
    thinking: boolean;
    numCtx: number;
    seed: number;
    temperature: number;
    outputCountConvention: string;
  };
  results: InferenceCaseResult[];
  engineTraces?: Record<string, InferenceTrace>;
  ollamaVersion?: string;
  completedAt?: string;
  errorCode?: InferenceEvidenceErrorCode;
  errorLocation?: string[];
}
