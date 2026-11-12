// Local-only tool acceptance cases and bounds; report values contain no conversation or identity data.
export const TOOL_ACCEPTANCE_CASES = {
  OPENAI_JSON: 'openai-json',
  OPENAI_STREAM: 'openai-stream',
  ANTHROPIC_JSON: 'anthropic-json',
  ANTHROPIC_STREAM: 'anthropic-stream',
  SCHEMA: 'invalid-schema',
  CHOICE: 'invalid-choice',
  SEQUENCE: 'invalid-sequence',
  UNSUPPORTED: 'unsupported-seller',
  PROVIDER: 'invalid-provider',
  CUT: 'cut-before-terminal',
  CANCEL: 'cancel-before-terminal',
  AUTOMATIC: 'automatic-refuses-tools',
} as const;
export type ToolAcceptanceCase =
  (typeof TOOL_ACCEPTANCE_CASES)[keyof typeof TOOL_ACCEPTANCE_CASES];
export const TOOL_ACCEPTANCE = {
  worker: 'tools-worker.ts',
  maxTokens: 64,
  inputTokens: 128,
  outputTokens: 12,
  maxRunMs: 60000,
  ioMs: 10000,
  workerArgumentCount: 3,
} as const;
export interface ToolCaseReport {
  case: ToolAcceptanceCase;
  generations: number;
  executionDials: number;
  queries: number;
  discoveryReads: number;
  registryReads: number;
  cancellations: number;
  forbiddenCalls: number;
  verifiedTurns: number;
}
export interface ToolAcceptanceReport {
  ok: true;
  nativeIroh: true;
  identityEnabled: true;
  paymentsEnabled: false;
  cases: ToolCaseReport[];
}
