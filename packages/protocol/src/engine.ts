// Owns the SDK-independent Engine port, its uniform failure and the domain usage contract.
// It must not know wallets, engine implementations or transport.
//
// Engine.generate settles in this order of precedence:
// 1. an aborted caller signal rejects with signal.reason, never an EngineError;
// 2. a failing onText or onFragment callback rejects with that callback's own error;
// 3. any engine or upstream failure rejects with EngineError;
// 4. programming errors (invalid maxTokens, unsupported messages) stay plain Error.
import type { EngineDoneReason, EngineErrorCode } from './constants';
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
