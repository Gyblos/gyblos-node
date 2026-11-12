// Free inference wire shapes only; execution, admission and replay storage belong to their callers.
import type { ChatMessage } from './chat';
import type {
  EngineDoneReason,
  FREE_EXECUTION,
  FreeExecutionCode,
  FreeExecutionStopReason,
  ReasoningLevel,
} from './constants';
import type { ModelSelection, SignedOfferV2 } from './control-types';
import type {
  TOOL_CALLS_DONE,
  ToolCall,
  ToolChatMessage,
  ToolInput,
} from './tools';

// A text message, an assistant turn that calls tools, or a tool's result.
export type FreeChatMessage = ToolChatMessage;
export interface FreeExecutionBuildInput extends ToolInput {
  messages: readonly FreeChatMessage[];
  maxTokens: number;
}
// The text-only input and result the paid and session channels carry.
export interface ExecutionInput {
  messages: ChatMessage[];
  selection: ModelSelection;
  reasoning: ReasoningLevel;
  maxTokens: number;
}
export interface ExecutionResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: EngineDoneReason;
}
export interface FreeExecutionRequest {
  version: typeof FREE_EXECUTION.version;
  requestId: string;
  quote: SignedOfferV2;
  input: ToolInput &
    Omit<ExecutionInput, 'messages'> & { messages: FreeChatMessage[] };
}
// The free channel's result, which may call tools instead of finishing with text.
export interface FreeExecutionResult extends Omit<
  ExecutionResult,
  'finishReason'
> {
  finishReason: EngineDoneReason | typeof TOOL_CALLS_DONE;
  // Present exactly when finishReason is tool_calls.
  toolCalls?: ToolCall[];
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
