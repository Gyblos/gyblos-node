// Owns the SDK-independent Engine port and domain usage contract.
// It must not know wallets, engine implementations or transport.
import type { EngineDoneReason } from './constants.js';
import type { EngineWireUsage } from './wire-usage.js';

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
  finishReason: EngineDoneReason;
}

export type EngineInput = (
  | { prompt: string; messages?: never }
  | { prompt?: never; messages: readonly { role: 'user'; content: string }[] }
) & {
  maxTokens: number;
  signal?: AbortSignal;
  onFragment?: () => Promise<void>;
  onText?: (text: string) => Promise<void>;
};

export interface Engine {
  generate(input: EngineInput): Promise<EngineResult>;
  capabilities(): EngineCapabilities;
  describe(): Promise<EngineDescription>;
}

export interface RecountTokenizer {
  count(text: string): number;
  input(prompt: string): number;
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
