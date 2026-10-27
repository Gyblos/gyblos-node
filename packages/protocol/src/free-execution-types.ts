// Free inference wire shapes only; execution, admission and replay storage belong to their callers.
import type {
  EngineDoneReason,
  FREE_EXECUTION,
  FreeChatRole,
  FreeExecutionCode,
  FreeExecutionStopReason,
  ReasoningLevel,
} from './constants';
import type { ModelSelection, SignedOfferV2 } from './control-types';

export interface FreeChatMessage {
  role: FreeChatRole;
  content: string;
}
export interface FreeExecutionBuildInput {
  messages: readonly FreeChatMessage[];
  maxTokens: number;
}
export interface FreeExecutionRequest {
  version: typeof FREE_EXECUTION.version;
  requestId: string;
  quote: SignedOfferV2;
  input: {
    messages: FreeChatMessage[];
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
// Present only with SELLER_CANNOT_CONTINUE; delivered only on a stream that already sent text.
export interface FreeExecutionDelivered {
  outputTokens: number;
}
export interface FreeExecutionStop {
  reason?: FreeExecutionStopReason;
  delivered?: FreeExecutionDelivered;
}
export type FreeExecutionFailure = {
  code: FreeExecutionCode;
} & FreeExecutionStop;
interface FreeExecutionReply {
  version: typeof FREE_EXECUTION.version;
  requestId: string;
  requestDigest: string;
}
export type FreeExecutionResponse = FreeExecutionReply &
  (
    | { result: FreeExecutionResult; error?: never }
    | { error: FreeExecutionFailure; result?: never }
  );
export interface FreeExecutionTrust {
  owner: string;
  nodeId: string;
  remoteNodeId: string;
  now: number;
}
