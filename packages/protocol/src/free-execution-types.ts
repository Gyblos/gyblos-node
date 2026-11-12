// Free inference wire shapes only; execution, admission and replay storage belong to their callers.
import type {
  FREE_EXECUTION,
  FreeExecutionCode,
  FreeExecutionStopReason,
} from './constants';
import type { SignedOfferV2 } from './control-types';
import type {
  InferenceBuildInput,
  InferenceInput,
  InferenceResult,
} from './inference';
import type { ToolChatMessage } from './tools';

export type FreeChatMessage = ToolChatMessage;
export type FreeExecutionBuildInput = InferenceBuildInput;
export type ExecutionInput = InferenceInput;
export type ExecutionResult = InferenceResult;
export interface FreeExecutionRequest {
  version: typeof FREE_EXECUTION.version;
  requestId: string;
  quote: SignedOfferV2;
  input: InferenceInput;
}
export type FreeExecutionResult = InferenceResult;
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
