import type { Config } from '@gyblos/gate/config';
import type { InferenceCaseName } from '@gyblos/gate/constants';
import type { InferenceGateEvidence, InferenceTrace } from '@gyblos/gate/types';
import type { ModelTokenizer } from '@gyblos/inference-ollama';
import type { SettlementEvent } from '@gyblos/payments-x402/facilitator';

export interface InferenceCase {
  name: InferenceCaseName;
  requestId: string;
  prompt: string;
}

export type { InferenceTrace } from '@gyblos/gate/types';

export interface CaseContext {
  url: string;
  config: Config;
  cases: InferenceCase[];
  controller: AbortController;
  buyerTokenizer: ModelTokenizer;
  salt: Uint8Array;
  evidence: InferenceGateEvidence;
  evidencePath: string;
  journalPath: string;
  events: () => Promise<SettlementEvent[]>;
  traces: Map<string, InferenceTrace>;
}
