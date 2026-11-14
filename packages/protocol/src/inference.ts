// Canonical inference data and metering port shared across economic policies; no transport, SDK or storage.
import {
  INFERENCE_CODES,
  type ControlMeteringMode,
  type EngineDoneReason,
  type ReasoningLevel,
} from './constants';
import type { ModelSelection } from './control-types';
import type { EngineUsage } from './engine';
import {
  hasToolTurns,
  type TOOL_CALLS_DONE,
  type ToolCall,
  type ToolChatMessage,
  type ToolChoice,
  type ToolDefinition,
  type ToolInput,
} from './tools';

export { INFERENCE_CODES } from './constants';

export type InferenceCode =
  (typeof INFERENCE_CODES)[keyof typeof INFERENCE_CODES];
export class InferenceError extends Error {
  constructor(readonly code: InferenceCode) {
    super(code);
    this.name = 'InferenceError';
  }
}
export interface InferenceBuildInput extends ToolInput {
  messages: readonly ToolChatMessage[];
  maxTokens: number;
}
export interface InferenceInput extends ToolInput {
  messages: ToolChatMessage[];
  maxTokens: number;
  selection: ModelSelection;
  reasoning: ReasoningLevel;
}
export interface InferenceUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface InferenceResult {
  text: string;
  usage: InferenceUsage;
  finishReason: EngineDoneReason | typeof TOOL_CALLS_DONE;
  toolCalls?: ToolCall[];
}
export interface InferenceMeter {
  mode: ControlMeteringMode;
  refunds: boolean;
  supportsToolCalls?: boolean;
  input(prompt: string): number;
  chat(
    messages: readonly ToolChatMessage[],
    tools?: readonly ToolDefinition[],
    toolChoice?: ToolChoice,
  ): number;
  streamed(text: string): number;
  stablePrefix?: import('./engine').RecountTokenizer['stablePrefix'];
  delivered(text: string, maxTokens: number): number;
  usage(
    text: string,
    reported: EngineUsage,
    inputTokens: number,
    calls?: readonly ToolCall[],
  ): InferenceUsage | undefined;
}

// One capability predicate for definitions and tool-result history, independent of pricing.
export const inferenceNeedsTools = (input: InferenceBuildInput): boolean =>
  Boolean(input.tools) || hasToolTurns(input.messages);
