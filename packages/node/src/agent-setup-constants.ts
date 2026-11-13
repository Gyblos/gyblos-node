// Names, limits and shapes shared by the agent configuration generators and the host commands.
export const AGENT_TOOLS = {
  OPENCODE: 'opencode',
  PI: 'pi',
  CODEX: 'codex',
  CLAUDE_CODE: 'claude',
} as const;
export type AgentTool = (typeof AGENT_TOOLS)[keyof typeof AGENT_TOOLS];

export const AGENT_SETUP = {
  provider: 'gyblos',
  name: 'Gyblos',
  // What a free endpoint accepts as a key: anything, but some clients refuse an empty one.
  freeKey: 'gyblos-local',
  // A context size for tools that need one when the buyer does not know the sellers' own.
  contextTokens: 32768,
  maxContextTokens: 10_000_000,
  maxModels: 32,
  namePattern: /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/,
  envPattern: /^[A-Z_][A-Z0-9_]{0,63}$/,
  // Where each tool reads its configuration, relative to its own directory (see agentFilePath).
  files: {
    opencode: 'opencode.json',
    pi: 'models.json',
    codex: 'config.toml',
  },
  codexProfileSuffix: '.config.toml',
} as const;

export interface AgentModel {
  id: string;
  maxOutputTokens: number;
  contextTokens?: number;
}
export interface AgentEndpoint {
  // The buyer's origin, e.g. http://127.0.0.1:4031.
  origin: string;
  models: readonly AgentModel[];
  // A paid endpoint's bearer token, by environment variable name; absent for a free endpoint.
  tokenEnv?: string;
}

export const CODEX_MARKS = {
  start: '# >>> gyblos (managed by pnpm buyer:agent codex)',
  end: '# <<< gyblos',
  profile: '# gyblos profile (managed by pnpm buyer:agent codex)',
} as const;

// Canonical configuration-generator error codes, shared with the host commands.
export const AGENT_SETUP_CODES = {
  ENDPOINT: 'ENDPOINT',
  FILE: 'FILE',
} as const;
