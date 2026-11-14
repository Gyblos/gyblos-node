// Owns the SDK-independent Engine port, its uniform failure and the domain usage contract.
// It must not know wallets, engine implementations or transport.
//
// Engine.generate settles in this order of precedence:
// 1. an aborted caller signal rejects with signal.reason, never an EngineError;
// 2. a failing onText or onFragment callback rejects with that callback's own error;
// 3. any engine or upstream failure rejects with EngineError;
// 4. programming errors (invalid maxTokens, unsupported messages) stay plain Error.
import { isConversation, type ChatMessage } from './chat';
import type { EngineDoneReason, EngineErrorCode } from './constants';
import {
  hasToolTurns,
  isToolConversation,
  type TOOL_CALLS_DONE,
  type ToolCall,
  type ToolChatMessage,
  type ToolChoice,
  type ToolDefinition,
} from './tools';
import type { EngineWireUsage } from './wire-usage';

// The message is the static code; provider text, bodies and headers never reach it.
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode) {
    super(code);
    this.name = 'EngineError';
  }
}

export interface EngineCapabilities {
  reportsUsage: boolean;
  logprobs: boolean;
  cancellable: boolean;
  recountable: boolean;
  modelIdentity: 'digest' | 'name-only';
}

export interface EngineDescription {
  name: string;
  digest?: string;
  contextTokens: number;
}

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  totalDurationNs: number;
  loadDurationNs: number;
  inputDurationNs: number;
  outputDurationNs: number;
}

export interface EngineResult {
  text: string;
  usage: EngineUsage;
  // tool_calls only when the input offered tools and the model called at least one.
  finishReason: EngineDoneReason | typeof TOOL_CALLS_DONE;
  toolCalls?: ToolCall[];
}

export type EngineInput = (
  | { prompt: string; messages?: never }
  | { prompt?: never; messages: readonly ToolChatMessage[] }
) & {
  maxTokens: number;
  // Offered only to an engine whose supportsTools() is true.
  tools?: readonly ToolDefinition[];
  toolChoice?: ToolChoice;
  signal?: AbortSignal;
  onFragment?: () => Promise<void>;
  // Text only: calls arrive whole in the result.
  onText?: (text: string) => Promise<void>;
};

export interface Engine {
  generate(input: EngineInput): Promise<EngineResult>;
  capabilities(): EngineCapabilities;
  describe(): Promise<EngineDescription>;
  // Whether generate() accepts tools and tool turns for this engine's model.
  supportsTools?(): boolean;
}

// The one user message the paid and HTTP paths serve; tools and other roles are programming errors there.
export function singleUserPrompt(input: EngineInput): string {
  if (input.prompt !== undefined) return input.prompt;
  if (
    input.messages.length !== 1 ||
    input.messages[0]?.role !== 'user' ||
    typeof input.messages[0].content !== 'string'
  )
    throw new Error('Only one user message without tools is supported.');
  return input.messages[0].content;
}

// The conversation an engine renders: a lone prompt is one user message. Anything else is a programming
// error, since the seller checks the conversation before any engine call.
export function engineConversation(input: EngineInput): readonly ChatMessage[] {
  if (input.prompt !== undefined)
    return [{ role: 'user', content: input.prompt }];
  if (input.tools || !isConversation(input.messages as readonly ChatMessage[]))
    throw new Error('Unsupported conversation shape.');
  return input.messages as readonly ChatMessage[];
}

// The conversation a tool-capable engine renders: text only, or with tools and tool turns.
export function engineToolConversation(
  input: EngineInput,
): readonly ToolChatMessage[] {
  if (input.prompt !== undefined)
    return [{ role: 'user', content: input.prompt }];
  if (!input.tools && !hasToolTurns(input.messages))
    return engineConversation(input);
  if (!isToolConversation(input.messages))
    throw new Error('Unsupported conversation shape.');
  return input.messages;
}

export interface StableTokenPrefix {
  characters: number;
  tokens: number;
}
export interface RecountTokenizer {
  count(text: string): number;
  input(prompt: string): number;
  // A certified prefix whose token IDs cannot change under any appended continuation.
  stablePrefix?(text: string, targetTokens?: number): StableTokenPrefix;
}

// A recount tokenizer that also counts a whole conversation as the model's template renders it.
export interface ChatTokenizer extends RecountTokenizer {
  chat(
    messages: readonly ToolChatMessage[],
    tools?: readonly ToolDefinition[],
    toolChoice?: ToolChoice,
  ): number;
  // What a result that called tools costs: its text and calls as the template writes an assistant turn.
  output?(text: string, toolCalls?: readonly ToolCall[]): number;
}

export function inferenceWireUsage(usage: EngineUsage): EngineWireUsage {
  return {
    prompt_eval_count: usage.inputTokens,
    eval_count: usage.outputTokens,
    total_duration: usage.totalDurationNs,
    load_duration: usage.loadDurationNs,
    prompt_eval_duration: usage.inputDurationNs,
    eval_duration: usage.outputDurationNs,
  };
}
