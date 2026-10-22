import type { ObservedDoneReason } from '@gyblos/application/constants';
import type { PRICES, TOLERANCE } from '@gyblos/application/metering';
import type { GENERATION } from '@gyblos/inference-ollama/constants';
import type { EngineUsage, MODEL } from '@gyblos/inference-ollama/index';
import type {
  ConfigAssetLabel,
  EVIDENCE_IDS,
  InferenceCaseName,
} from '@gyblos/lab-harness/constants';

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
  stoppedSignal?: NodeJS.Signals;
}

export interface InferenceTransaction {
  signature: string;
  slot: number;
  transfers: ReturnType<typeof transactionTransfers>;
}

export interface InferenceCaseResult {
  case: InferenceCaseName;
  measurement: Measurement;
  before: InferenceSnapshot;
  duringDeposit: InferenceSnapshot;
  after: InferenceSnapshot;
  trace: InferenceTrace;
  refundAtomic: string;
  engineUsage: EngineUsage | null;
  doneReason: ObservedDoneReason | null;
  onChain: { open: InferenceTransaction; claim: InferenceTransaction };
}

export interface InferenceGateEvidence extends EvidenceBase {
  evidenceId: typeof EVIDENCE_IDS.INFERENCE;
  assetLabel: ConfigAssetLabel;
  createdAt: string;
  runId: string;
  model: typeof MODEL;
  prices: typeof PRICES;
  tolerance: typeof TOLERANCE;
  template: {
    raw: true;
    thinking: false;
    numCtx: typeof GENERATION.numCtx;
    seed: typeof GENERATION.seed;
    temperature: typeof GENERATION.temperature;
    outputCountConvention: string;
  };
  results: InferenceCaseResult[];
  engineTraces?: Record<string, InferenceTrace>;
  ollamaVersion?: string;
  completedAt?: string;
  errorCode?: InferenceEvidenceErrorCode;
  errorLocation?: string[];
}
