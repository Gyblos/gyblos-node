import type { inferenceSnapshot } from '@gyblos/gate/chain';
import type { Config } from '@gyblos/gate/config';
import type { GateEvidence } from '@gyblos/gate/types';
import type { ModelTokenizer } from '@gyblos/inference-ollama';
import type { SettlementEvent } from '@gyblos/payments-x402/facilitator';

export interface InferenceCase {
  name: string;
  requestId: string;
  prompt: string;
}
export interface InferenceTrace {
  channelId: string;
  depositConfirmedAt: string;
  engineStartedAt: string;
  during: Awaited<ReturnType<typeof inferenceSnapshot>>;
  firstFragmentAt?: string;
  stoppedAt?: string;
  stoppedSignal?: string;
}
export interface CaseContext {
  url: string;
  config: Config;
  cases: InferenceCase[];
  controller: AbortController;
  buyerTokenizer: ModelTokenizer;
  salt: Uint8Array;
  evidence: GateEvidence;
  evidencePath: string;
  journalPath: string;
  events: () => Promise<SettlementEvent[]>;
  traces: Map<string, InferenceTrace>;
}
