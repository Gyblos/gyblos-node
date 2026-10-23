// Evidence types for the inference gate (GYB-GATE-0005): per-case results, engine traces and
// on-chain open/claim transfers.
import type { ObservedDoneReason } from '@gyblos/core/constants';
import type { PRICES, TOLERANCE } from '@gyblos/core/metering';
import type { EngineUsage, MODEL } from '@gyblos/engine-ollama';
import type { GENERATION } from '@gyblos/engine-ollama/constants';
import type { Measurement } from '@gyblos/node/measurements';
import type {
  inferenceSnapshot,
  transactionTransfers,
} from '@gyblos/payments-x402/accounting/chain';

import type {
  ConfigAssetLabel,
  EVIDENCE_IDS,
  InferenceCaseName,
  InferenceEvidenceErrorCode,
} from './constants.js';
import type { EvidenceBase } from './evidence-types.js';

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
