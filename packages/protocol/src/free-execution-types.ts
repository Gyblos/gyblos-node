// Free inference wire shapes only; execution, admission and replay storage belong to their callers.
import type {
  EngineDoneReason,
  FREE_EXECUTION,
  FreeChatRole,
  FreeExecutionCode,
  ReasoningLevel,
} from './constants.js';
import type { ModelSelection, SignedOfferV2 } from './control-types.js';

export interface FreeExecutionRequest {
  version: typeof FREE_EXECUTION.version;
  requestId: string;
  quote: SignedOfferV2;
  input: {
    messages: { role: FreeChatRole; content: string }[];
    selection: ModelSelection;
    reasoning: ReasoningLevel;
    maxTokens: number;
  };
}
export interface FreeExecutionResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: EngineDoneReason;
}
interface FreeExecutionReply {
  version: typeof FREE_EXECUTION.version;
  requestId: string;
  requestDigest: string;
}
export type FreeExecutionResponse = FreeExecutionReply &
  (
    | { result: FreeExecutionResult; error?: never }
    | { error: { code: FreeExecutionCode }; result?: never }
  );
export interface FreeExecutionTrust {
  owner: string;
  nodeId: string;
  remoteNodeId: string;
  now: number;
}
