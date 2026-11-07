// Validates the desktop's local sandbox agent connection details at the IPC boundary.
import { PAYPAL_SANDBOX_LIMIT_OPTIONS } from '@gyblos/config/constants';
import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config/hosts';
import { SANDBOX_AGENT_LIMITS } from '@gyblos/config/limits';
import { ROUTES } from '@gyblos/config/paths';

import {
  AGENT_CLIENT,
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_COPY,
  PAYPAL_AGENT_ERROR,
  PAYPAL_AGENT_USAGE_STATE,
  type PaypalAgentUsageState,
} from './constants';
import { paypalAgentExample } from './paypal-agent-example';

export { paypalAgentExample } from './paypal-agent-example';

export {
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_ERROR,
  PAYPAL_AGENT_COPY,
  PAYPAL_AGENT_USAGE_STATE,
  type PaypalAgentUsageState,
} from './constants';
export { createPaypalAgentStatusPoll } from './paypal-agent-poll';
export const DESKTOP_PAYPAL_AGENT = {
  CHANNEL: 'desktop:paypal-agent',
  COPY_CHANNEL: 'desktop:paypal-agent-copy',
  TOKEN_BYTES: 32,
  TOKEN_CHARACTERS: 43,
  MODEL_CHARACTERS: 128,
  MODEL: 'gpt-oss:20b',
  POLL_MS: 2000,
  RESPONSE_DRAIN_MS: 10_000,
} as const;
export const PAYPAL_AGENT_CLIENT = {
  OPENCODE: AGENT_CLIENT.OPENCODE,
  CODEX: AGENT_CLIENT.CODEX,
  PI: AGENT_CLIENT.PI,
  CLAUDE_CODE: AGENT_CLIENT.CLAUDE_CODE,
} as const;
export type PaypalAgentClient =
  (typeof PAYPAL_AGENT_CLIENT)[keyof typeof PAYPAL_AGENT_CLIENT];
export type PaypalAgentCopyTarget =
  | PaypalAgentClient
  | (typeof PAYPAL_AGENT_COPY)[keyof typeof PAYPAL_AGENT_COPY];
export class PaypalAgentConnectionError extends Error {
  constructor(
    readonly code:
      | typeof PAYPAL_AGENT_ERROR.MODEL_UNAVAILABLE
      | typeof PAYPAL_AGENT_ERROR.NEW_SESSION_REQUIRED,
  ) {
    super(code);
  }
}
export function paypalAgentErrorMessage(error: PaypalAgentResult['error']) {
  if (error === PAYPAL_AGENT_ERROR.MODEL_UNAVAILABLE)
    return `Check that ${DESKTOP_PAYPAL_AGENT.MODEL} is installed in Ollama. Settle this session in Payments, restart Gyblos, and start a new session.`;
  if (error === PAYPAL_AGENT_ERROR.NEW_SESSION_REQUIRED)
    return 'Settle the current session in Payments and start a new one to connect the agent.';
  return 'Check that a PayPal Sandbox session is active in Payments, then try again.';
}
export type PaypalAgentAction =
  (typeof PAYPAL_AGENT_ACTION)[keyof typeof PAYPAL_AGENT_ACTION];
export type PaypalAgentResult = {
  connection: {
    url: string;
    key: string;
    model: string;
    spentCents: number;
    limitCents: number;
    usageUncertain: boolean;
    disconnecting: boolean;
    usageState: PaypalAgentUsageState;
  } | null;
  error: (typeof PAYPAL_AGENT_ERROR)[keyof typeof PAYPAL_AGENT_ERROR] | null;
};

type AgentConnection = NonNullable<PaypalAgentResult['connection']>;

export function canCreatePaypalAgent(
  connection: PaypalAgentResult['connection'],
  statusUnavailable: boolean,
  busy: boolean,
  onlyConnected: boolean,
  sessionReady: boolean,
) {
  return (
    !connection && !statusUnavailable && !busy && !onlyConnected && sessionReady
  );
}
// Navigation remains available without authorizing or creating a connection.
export function paypalAgentNeedsPayments(
  connection: PaypalAgentResult['connection'],
  onlyConnected: boolean,
  sessionReady: boolean,
) {
  return !connection && (onlyConnected || !sessionReady);
}
export function paypalAgentConnectionLabel(
  connection: PaypalAgentResult['connection'],
  busy: boolean,
  statusUnavailable: boolean,
) {
  if (busy) return 'Checking connection';
  if (statusUnavailable) return 'Connection status unavailable';
  if (connection?.usageUncertain) return 'Session needs attention';
  return connection ? 'Local connection active' : 'No local connection';
}
export function paypalAgentIsReady(
  connection: PaypalAgentResult['connection'],
  busy: boolean,
  statusUnavailable: boolean,
) {
  return (
    !!connection &&
    !busy &&
    !statusUnavailable &&
    !connection.usageUncertain &&
    !connection.disconnecting &&
    connection.usageState === PAYPAL_AGENT_USAGE_STATE.AVAILABLE
  );
}
export function opencodeConfig(
  connection: Pick<AgentConnection, 'url' | 'key' | 'model'>,
) {
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      model: `gyblos/${connection.model}`,
      agent: { title: { disable: true } },
      provider: {
        gyblos: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Gyblos Sandbox',
          options: { baseURL: connection.url, apiKey: '{env:GYBLOS_API_KEY}' },
          models: {
            [connection.model]: {
              name: connection.model,
              tool_call: true,
              limit: {
                context: SANDBOX_AGENT_LIMITS.contextTokens,
                output: SANDBOX_AGENT_LIMITS.maxOutputTokens,
              },
            },
          },
        },
      },
    },
    null,
    2,
  );
}
export function piConfig(
  connection: Pick<AgentConnection, 'url' | 'key' | 'model'>,
) {
  return JSON.stringify(
    {
      providers: {
        gyblos: {
          baseUrl: connection.url,
          api: 'openai-completions',
          apiKey: '$GYBLOS_API_KEY',
          models: [
            {
              id: connection.model,
              name: connection.model,
              reasoning: false,
              input: ['text'],
              contextWindow: SANDBOX_AGENT_LIMITS.contextTokens,
              maxTokens: SANDBOX_AGENT_LIMITS.maxOutputTokens,
              compat: {
                supportsStore: false,
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
                supportsStrictMode: false,
              },
            },
          ],
        },
      },
    },
    null,
    2,
  );
}
export function piSettings() {
  return JSON.stringify(
    {
      retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false },
      cacheWarming: 'off',
    },
    null,
    2,
  );
}
export function codexConfig(
  connection: Pick<AgentConnection, 'url' | 'key' | 'model'>,
) {
  return [
    'model_provider = "gyblos"',
    `model = ${JSON.stringify(connection.model)}`,
    `model_context_window = ${SANDBOX_AGENT_LIMITS.contextTokens}`,
    'web_search = "disabled"',
    '',
    '[features]',
    'multi_agent = false',
    'view_image = false',
    '',
    '[model_providers.gyblos]',
    'name = "Gyblos Sandbox"',
    `base_url = ${JSON.stringify(connection.url)}`,
    'env_key = "GYBLOS_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
  ].join('\n');
}
function shellLiteral(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function claudeCodeConfig(
  connection: Pick<AgentConnection, 'url' | 'key' | 'model'>,
) {
  return [
    `export ANTHROPIC_BASE_URL=${shellLiteral(new URL(connection.url).origin)}`,
    'export ANTHROPIC_AUTH_TOKEN="$GYBLOS_API_KEY"',
    'export ANTHROPIC_API_KEY="$GYBLOS_API_KEY"',
    `export ANTHROPIC_MODEL=${shellLiteral(connection.model)}`,
    `export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${SANDBOX_AGENT_LIMITS.contextTokens}`,
    `export CLAUDE_CODE_MAX_OUTPUT_TOKENS=${SANDBOX_AGENT_LIMITS.maxOutputTokens}`,
    'export CLAUDE_CODE_DISABLE_THINKING=1',
    'export CLAUDE_CODE_EFFORT_LEVEL=auto',
    'export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1',
    'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false',
  ].join('\n');
}
export function claudeCodePowerShellConfig(
  connection: Pick<AgentConnection, 'url' | 'key' | 'model'>,
) {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    `$env:ANTHROPIC_BASE_URL = ${literal(new URL(connection.url).origin)}`,
    '$env:ANTHROPIC_AUTH_TOKEN = $env:GYBLOS_API_KEY',
    '$env:ANTHROPIC_API_KEY = $env:GYBLOS_API_KEY',
    `$env:ANTHROPIC_MODEL = ${literal(connection.model)}`,
    `$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = '${SANDBOX_AGENT_LIMITS.contextTokens}'`,
    `$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = '${SANDBOX_AGENT_LIMITS.maxOutputTokens}'`,
    "$env:CLAUDE_CODE_DISABLE_THINKING = '1'",
    "$env:CLAUDE_CODE_EFFORT_LEVEL = 'auto'",
    "$env:CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1'",
    "$env:CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'false'",
  ].join('\n');
}
export function paypalAgentCopyText(
  connection: AgentConnection,
  target: PaypalAgentCopyTarget,
) {
  switch (target) {
    case PAYPAL_AGENT_COPY.KEY:
      return connection.key;
    case PAYPAL_AGENT_COPY.URL:
      return connection.url;
    case PAYPAL_AGENT_COPY.MODEL:
      return connection.model;
    case PAYPAL_AGENT_COPY.EXAMPLE:
      return paypalAgentExample(connection);
    case PAYPAL_AGENT_COPY.PI_SETTINGS:
      return piSettings();
    case PAYPAL_AGENT_COPY.CLAUDE_POWERSHELL:
      return claudeCodePowerShellConfig(connection);
    case PAYPAL_AGENT_CLIENT.CODEX:
      return codexConfig(connection);
    case PAYPAL_AGENT_CLIENT.PI:
      return piConfig(connection);
    case PAYPAL_AGENT_CLIENT.CLAUDE_CODE:
      return claudeCodeConfig(connection);
    case PAYPAL_AGENT_CLIENT.OPENCODE:
      return opencodeConfig(connection);
  }
}
export function retainPaypalAgentStatus(
  previous: PaypalAgentResult,
  next: PaypalAgentResult | undefined,
) {
  if (!next || next.error) return { result: previous, unavailable: true };
  return { result: next, unavailable: false };
}
export function paypalAgentStatusUnavailable(
  action: PaypalAgentAction,
  next: PaypalAgentResult | undefined,
  stalled: boolean,
) {
  const disconnected =
    action === PAYPAL_AGENT_ACTION.DISCONNECT &&
    !!next &&
    !next.error &&
    !next.connection;
  return !disconnected && (stalled || !next || !!next.error);
}
export function agentFailure(
  error: PaypalAgentResult['error'] = PAYPAL_AGENT_ERROR.FAILED,
): PaypalAgentResult {
  return { connection: null, error };
}
function fields(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
function connection(value: unknown): PaypalAgentResult['connection'] {
  const row = fields(value);
  if (
    !row ||
    Object.keys(row).sort().join(',') !==
      'disconnecting,key,limitCents,model,spentCents,url,usageState,usageUncertain'
  )
    return null;
  const usageState = Object.values(PAYPAL_AGENT_USAGE_STATE).find(
    (entry) => entry === row.usageState,
  );
  if (
    !usageState ||
    row.usageUncertain !==
      (usageState !== PAYPAL_AGENT_USAGE_STATE.AVAILABLE) ||
    row.disconnecting !==
      (usageState === PAYPAL_AGENT_USAGE_STATE.DISCONNECTING)
  )
    return null;
  if (
    typeof row.url !== 'string' ||
    !URL.canParse(row.url) ||
    typeof row.key !== 'string' ||
    row.key.length !== DESKTOP_PAYPAL_AGENT.TOKEN_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/.test(row.key) ||
    typeof row.model !== 'string' ||
    !row.model ||
    row.model.length > DESKTOP_PAYPAL_AGENT.MODEL_CHARACTERS ||
    typeof row.spentCents !== 'number' ||
    !Number.isSafeInteger(row.spentCents) ||
    row.spentCents < 0 ||
    typeof row.limitCents !== 'number' ||
    !PAYPAL_SANDBOX_LIMIT_OPTIONS.some((limit) => limit === row.limitCents) ||
    row.spentCents > row.limitCents ||
    typeof row.usageUncertain !== 'boolean' ||
    typeof row.disconnecting !== 'boolean'
  )
    return null;
  const url = new URL(row.url);
  if (
    url.protocol !== 'http:' ||
    ![LOCALHOST, IPV6_LOOPBACK].includes(url.hostname) ||
    !url.port ||
    url.pathname !== ROUTES.agentBase ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  return {
    url: row.url,
    key: row.key,
    model: row.model,
    spentCents: row.spentCents,
    limitCents: row.limitCents,
    usageUncertain: row.usageUncertain,
    disconnecting: row.disconnecting,
    usageState,
  };
}
export function parsePaypalAgentResult(value: unknown): PaypalAgentResult {
  const row = fields(value);
  if (!row || Object.keys(row).sort().join(',') !== 'connection,error')
    return agentFailure();
  const error =
    row.error === null
      ? null
      : Object.values(PAYPAL_AGENT_ERROR).find((entry) => entry === row.error);
  if (error === undefined) return agentFailure();
  const parsed = row.connection === null ? null : connection(row.connection);
  if ((row.connection !== null && !parsed) || (error && parsed))
    return agentFailure();
  return { connection: parsed, error };
}
