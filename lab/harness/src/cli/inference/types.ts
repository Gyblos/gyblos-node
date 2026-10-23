// Shared case and context types for the inference-gate modules.
import type { ModelTokenizer } from '@gyblos/engine-ollama';
import type { SettlementEvent } from '@gyblos/payments-x402/facilitator';

import type { Config } from '../../config.js';
import type { InferenceCaseName } from '../../constants.js';
import type { InferenceGateEvidence, InferenceTrace } from '../../types.js';

export interface InferenceCase {
  name: InferenceCaseName;
  requestId: string;
  prompt: string;
}

export type { InferenceTrace } from '../../types.js';

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
