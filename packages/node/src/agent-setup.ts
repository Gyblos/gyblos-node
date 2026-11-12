import { join } from 'node:path';

// One source for connecting coding agents to a local Gyblos buyer: OpenCode, pi, Codex CLI and Claude Code.
// From the endpoint and the models it serves, each tool gets its own configuration text, and the JSON
// files a tool reads can be merged without touching anything but the `gyblos` provider. Both the buyer
// command and the desktop app use these, so the two never drift. Pure: no files, network or secrets; a
// paid endpoint's token is referenced by environment variable name, never written.

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

// The file a tool reads, honoring the variables each tool uses to move its configuration.
export function agentFilePath(
  tool: keyof typeof AGENT_SETUP.files,
  home: string,
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  if (tool === AGENT_TOOLS.CODEX)
    return join(
      environment.CODEX_HOME || join(home, '.codex'),
      AGENT_SETUP.files.codex,
    );
  if (tool === AGENT_TOOLS.PI)
    return join(
      environment.PI_CODING_AGENT_DIR || join(home, '.pi/agent'),
      AGENT_SETUP.files.pi,
    );
  return (
    environment.OPENCODE_CONFIG ||
    join(
      environment.XDG_CONFIG_HOME || join(home, '.config'),
      'opencode',
      AGENT_SETUP.files.opencode,
    )
  );
}

export class AgentSetupError extends Error {
  constructor(readonly code: 'ENDPOINT' | 'FILE') {
    super(code);
    this.name = 'AgentSetupError';
  }
}

function checked(endpoint: AgentEndpoint): AgentEndpoint {
  const url = new URL(endpoint.origin);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.origin !== endpoint.origin ||
    !endpoint.models.length ||
    endpoint.models.length > AGENT_SETUP.maxModels ||
    endpoint.models.some(
      (model) =>
        !AGENT_SETUP.namePattern.test(model.id) ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        model.maxOutputTokens < 1 ||
        (model.contextTokens !== undefined &&
          (!Number.isSafeInteger(model.contextTokens) ||
            model.contextTokens <= model.maxOutputTokens ||
            model.contextTokens > AGENT_SETUP.maxContextTokens)),
    ) ||
    (endpoint.tokenEnv !== undefined &&
      !AGENT_SETUP.envPattern.test(endpoint.tokenEnv))
  )
    throw new AgentSetupError('ENDPOINT');
  return endpoint;
}
const context = (model: AgentModel) =>
  model.contextTokens ?? AGENT_SETUP.contextTokens;
const base = (endpoint: AgentEndpoint) => `${endpoint.origin}/v1`;

// OpenCode: an openai-compatible provider with every model and its limits.
export function opencodeProvider(endpoint: AgentEndpoint) {
  const { models, tokenEnv } = checked(endpoint);
  return {
    npm: '@ai-sdk/openai-compatible',
    name: AGENT_SETUP.name,
    options: {
      baseURL: base(endpoint),
      apiKey: tokenEnv ? `{env:${tokenEnv}}` : AGENT_SETUP.freeKey,
    },
    models: Object.fromEntries(
      models.map((model) => [
        model.id,
        {
          name: model.id,
          tool_call: true,
          limit: { context: context(model), output: model.maxOutputTokens },
        },
      ]),
    ),
  };
}

// pi: a provider speaking Chat Completions, without the OpenAI-only options it would otherwise send.
export function piProvider(endpoint: AgentEndpoint) {
  const { models, tokenEnv } = checked(endpoint);
  return {
    baseUrl: base(endpoint),
    api: 'openai-completions',
    apiKey: tokenEnv ? `$${tokenEnv}` : AGENT_SETUP.freeKey,
    models: models.map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: false,
      input: ['text'],
      contextWindow: context(model),
      maxTokens: model.maxOutputTokens,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
      },
    })),
  };
}

// Codex CLI: tables only, so the block can sit at the end of any config.toml. A provider speaking the
// Responses API with retries off (a retry would resend the prompt), and one profile per model; run
// `codex --profile gyblos` (the first model) or `codex --profile gyblos-<model>`. Profiles take no context
// size: when a conversation outgrows what the network carries, the buyer answers with the code Codex
// compacts on.
export function codexBlock(endpoint: AgentEndpoint) {
  const { models, tokenEnv } = checked(endpoint);
  const toml = (value: string) => JSON.stringify(value);
  const profile = (name: string, model: AgentModel) => [
    '',
    `[profiles.${toml(name)}]`,
    `model_provider = ${toml(AGENT_SETUP.provider)}`,
    `model = ${toml(model.id)}`,
    // No seller runs web search; leaving it out also keeps it out of every request.
    'web_search = "disabled"',
  ];
  return [
    CODEX_MARKS.start,
    `[model_providers.${AGENT_SETUP.provider}]`,
    `name = ${toml(AGENT_SETUP.name)}`,
    `base_url = ${toml(base(endpoint))}`,
    ...(tokenEnv ? [`env_key = ${toml(tokenEnv)}`] : []),
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    ...profile(AGENT_SETUP.provider, models[0]!),
    ...profileNames(models).flatMap((name, index) =>
      profile(name, models[index]!),
    ),
    CODEX_MARKS.end,
  ].join('\n');
}
// One profile name per model: its id with other characters as dashes, numbered when two ids collide.
export function profileNames(models: readonly AgentModel[]) {
  const used = new Set<string>([AGENT_SETUP.provider]);
  return models.map((model) => {
    const plain = `${AGENT_SETUP.provider}-${model.id.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`;
    let name = plain;
    for (let count = 2; used.has(name); count++) name = `${plain}-${count}`;
    used.add(name);
    return name;
  });
}
export const CODEX_MARKS = {
  start: '# >>> gyblos (managed by pnpm buyer:agent codex)',
  end: '# <<< gyblos',
} as const;

// Claude Code: environment for one shell. `/model <name>` then switches among the endpoint's models.
export function claudeCodeEnvironment(endpoint: AgentEndpoint) {
  const { models, tokenEnv } = checked(endpoint);
  const first = models[0]!;
  const key = tokenEnv ? `"$${tokenEnv}"` : AGENT_SETUP.freeKey;
  return [
    `export ANTHROPIC_BASE_URL=${endpoint.origin}`,
    `export ANTHROPIC_AUTH_TOKEN=${key}`,
    `export ANTHROPIC_MODEL=${first.id}`,
    // Claude Code's own aliases (and the subagents that use them) would ask for Anthropic models this
    // endpoint does not serve; each points at a served one. The others are picked with /model <name>.
    `export ANTHROPIC_DEFAULT_OPUS_MODEL=${first.id}`,
    `export ANTHROPIC_DEFAULT_SONNET_MODEL=${first.id}`,
    `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${first.id}`,
    ...(models[1]
      ? [`export ANTHROPIC_CUSTOM_MODEL_OPTION=${models[1].id}`]
      : []),
    `export CLAUDE_CODE_MAX_OUTPUT_TOKENS=${first.maxOutputTokens}`,
    'export CLAUDE_CODE_DISABLE_THINKING=1',
  ].join('\n');
}

type Json = Record<string, unknown>;
function jsonObject(text: string | undefined): Json {
  if (text === undefined || !text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Json;
  } catch {
    // Comments or other JSONC: refused below rather than rewritten without them.
  }
  throw new AgentSetupError('FILE');
}
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};

// The tool's file with the gyblos provider set and everything else kept as it was. OpenCode gets a
// default model only when the user has none.
export function mergedAgentFile(
  tool: typeof AGENT_TOOLS.OPENCODE | typeof AGENT_TOOLS.PI,
  endpoint: AgentEndpoint,
  existing: string | undefined,
) {
  const file = jsonObject(existing);
  if (tool === AGENT_TOOLS.OPENCODE) {
    const merged: Json = {
      $schema: 'https://opencode.ai/config.json',
      ...file,
      provider: {
        ...object(file.provider),
        [AGENT_SETUP.provider]: opencodeProvider(endpoint),
      },
    };
    merged.model ??= `${AGENT_SETUP.provider}/${endpoint.models[0]!.id}`;
    return `${JSON.stringify(merged, null, 2)}\n`;
  }
  return `${JSON.stringify(
    {
      ...file,
      providers: {
        ...object(file.providers),
        [AGENT_SETUP.provider]: piProvider(endpoint),
      },
    },
    null,
    2,
  )}\n`;
}

// config.toml with the managed gyblos block replaced, or added at the end.
export function mergedCodexConfig(
  endpoint: AgentEndpoint,
  existing: string | undefined,
) {
  const block = codexBlock(endpoint);
  const text = existing ?? '';
  const start = text.indexOf(CODEX_MARKS.start);
  const end = text.indexOf(CODEX_MARKS.end);
  if (start >= 0 && end > start)
    return `${text.slice(0, start)}${block}${text.slice(end + CODEX_MARKS.end.length)}`;
  if (start >= 0 || end >= 0) throw new AgentSetupError('FILE');
  // Tables of the same names outside the block would be defined twice, which breaks the whole file.
  if (/^\s*\[\s*(model_providers|profiles)\s*\.\s*"?gyblos/m.test(text))
    throw new AgentSetupError('FILE');
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}\n`;
}
