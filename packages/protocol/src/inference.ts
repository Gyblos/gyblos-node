// Canonical inference data and metering port shared across economic policies; no transport, SDK or storage.
import type { ModelSelection } from './control-types';
import type { ControlMeteringMode, ReasoningLevel } from './constants';
import type { EngineUsage } from './engine';
import type { EngineDoneReason } from './constants';
import type { ToolCall, ToolChatMessage, ToolChoice, ToolDefinition, ToolInput, TOOL_CALLS_DONE } from './tools';

export const INFERENCE_CODES = { INVALID: 'INFERENCE_INVALID', UNSUPPORTED: 'INFERENCE_UNSUPPORTED', LIMIT: 'INFERENCE_LIMIT', INTERNAL: 'INFERENCE_INTERNAL' } as const;
export type InferenceCode = (typeof INFERENCE_CODES)[keyof typeof INFERENCE_CODES];
export class InferenceError extends Error { constructor(readonly code: InferenceCode) { super(code); this.name = 'InferenceError'; } }
export interface InferenceBuildInput extends ToolInput { messages: readonly ToolChatMessage[]; maxTokens: number; }
export interface InferenceInput extends ToolInput { messages: ToolChatMessage[]; maxTokens: number; selection: ModelSelection; reasoning: ReasoningLevel; }
export interface InferenceUsage { inputTokens: number; outputTokens: number; }
export interface InferenceResult { text: string; usage: InferenceUsage; finishReason: EngineDoneReason | typeof TOOL_CALLS_DONE; toolCalls?: ToolCall[]; }
export interface InferenceMeter {
  mode: ControlMeteringMode; refunds: boolean; supportsToolCalls?: boolean;
  input(prompt: string): number;
  chat(messages: readonly ToolChatMessage[], tools?: readonly ToolDefinition[], toolChoice?: ToolChoice): number;
  streamed(text: string): number;
  delivered(text: string, maxTokens: number): number;
  usage(text: string, reported: EngineUsage, inputTokens: number, calls?: readonly ToolCall[]): InferenceUsage | undefined;
}
