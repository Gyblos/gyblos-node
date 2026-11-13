// Shared configuration text and safe merges for coding agents using one local buyer endpoint.
// Pure configuration only: no files, network or secret values; tokens use environment references.
// Node owns the generators, and each host owns its file writes.
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse } from 'smol-toml';

import {
  AGENT_SETUP,
  AGENT_SETUP_CODES,
  AGENT_TOOLS,
  type AgentTool,
} from './agent-setup-constants';

export {
  AGENT_SETUP,
  AGENT_SETUP_CODES,
  AGENT_TOOLS,
  type AgentTool,
} from './agent-setup-constants';

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
  constructor(
    readonly code: (typeof AGENT_SETUP_CODES)[keyof typeof AGENT_SETUP_CODES],
  ) {
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
    throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
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
  throw new AgentSetupError(AGENT_SETUP_CODES.FILE);
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

// Validate complete TOML, not table prefixes: quoted/escaped names must obey the same collision rules.
function configToml(text: string): Json {
  try {
    return parse(text);
  } catch {
    throw new AgentSetupError(AGENT_SETUP_CODES.FILE);
  }
}
function managedBlock(text: string) {
  const managed = configToml(text);
  const provider = object(managed.model_providers);
  const profiles = object(managed.profiles);
  const allowed = configToml(
    codexBlock({
      origin: 'http://127.0.0.1:4031',
      models: [{ id: 'model', maxOutputTokens: 1 }],
      tokenEnv: 'TOKEN',
    }),
  );
  const providerKeys = Object.keys(
    object(object(allowed.model_providers)[AGENT_SETUP.provider]),
  );
  const profileKeys = Object.keys(
    object(object(allowed.profiles)[AGENT_SETUP.provider]),
  );
  if (
    Object.keys(managed).some(
      (key) => key !== 'model_providers' && key !== 'profiles',
    ) ||
    Object.keys(provider).some((key) => key !== AGENT_SETUP.provider) ||
    Object.keys(object(provider[AGENT_SETUP.provider])).some(
      (key) => !providerKeys.includes(key),
    ) ||
    Object.entries(profiles).some(
      ([key, value]) =>
        !key.startsWith(AGENT_SETUP.provider) ||
        Object.keys(object(value)).some(
          (field) => !profileKeys.includes(field),
        ),
    )
  )
    throw new AgentSetupError(AGENT_SETUP_CODES.FILE);
}
// config.toml with exactly one managed block replaced, retaining all unrelated text and tables.
export function mergedCodexConfig(
  endpoint: AgentEndpoint,
  existing: string | undefined,
) {
  const block = codexBlock(endpoint);
  const text = existing ?? '';
  const original = configToml(text);
  const start = text.indexOf(CODEX_MARKS.start);
  const end = text.indexOf(CODEX_MARKS.end);
  let outside = text;
  let merged: string;
  let prior: Json | undefined;
  if (start >= 0 || end >= 0) {
    const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
    if (
      start < 0 ||
      end < start ||
      text.indexOf(CODEX_MARKS.start, start + 1) >= 0 ||
      text.indexOf(CODEX_MARKS.end, end + 1) >= 0 ||
      !lines.includes(CODEX_MARKS.start) ||
      !lines.includes(CODEX_MARKS.end)
    )
      throw new AgentSetupError(AGENT_SETUP_CODES.FILE);
    managedBlock(text.slice(start, end));
    prior = configToml(text.slice(start, end));
    outside = text.slice(0, start) + text.slice(end + CODEX_MARKS.end.length);
    merged =
      text.slice(0, start) + block + text.slice(end + CODEX_MARKS.end.length);
  } else
    merged = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}\n`;
  const user = configToml(outside);
  if (
    Object.hasOwn(object(user.model_providers), AGENT_SETUP.provider) ||
    Object.keys(object(user.profiles)).some((key) =>
      key.startsWith(AGENT_SETUP.provider),
    )
  )
    throw new AgentSetupError(AGENT_SETUP_CODES.FILE);
  const joined = (managed: Json) => ({
    ...user,
    model_providers: {
      ...object(user.model_providers),
      ...object(managed.model_providers),
    },
    profiles: { ...object(user.profiles), ...object(managed.profiles) },
  });
  if (
    (prior &&
      !isDeepStrictEqual(original, joined(prior), { skipPrototype: true })) ||
    !isDeepStrictEqual(configToml(merged), joined(configToml(block)), {
      skipPrototype: true,
    })
  )
    throw new AgentSetupError(AGENT_SETUP_CODES.FILE);
  return merged;
}
