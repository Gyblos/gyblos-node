// Validates the desktop's local sandbox agent connection details at the IPC boundary.
import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config/hosts';
import { SANDBOX_AGENT_LIMITS } from '@gyblos/config/limits';
import { ROUTES } from '@gyblos/config/paths';

export const DESKTOP_PAYPAL_AGENT = {
  CHANNEL: 'desktop:paypal-agent',
  TOKEN_BYTES: 32,
  TOKEN_CHARACTERS: 43,
  MODEL_CHARACTERS: 128,
  MODEL: 'gpt-oss:20b',
  POLL_MS: 2000,
} as const;
export const PAYPAL_AGENT_ACTION = {
  STATUS: 'status',
  CONNECT: 'connect',
  CONFIRM: 'confirm',
  DISCONNECT: 'disconnect',
} as const;
export const PAYPAL_AGENT_ERROR = {
  DENIED: 'denied',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
} as const;
export type PaypalAgentAction =
  (typeof PAYPAL_AGENT_ACTION)[keyof typeof PAYPAL_AGENT_ACTION];
export type PaypalAgentResult = {
  connection: {
    url: string;
    key: string;
    model: string;
    pending: boolean;
  } | null;
  error: (typeof PAYPAL_AGENT_ERROR)[keyof typeof PAYPAL_AGENT_ERROR] | null;
};
export function opencodeConfig(
  connection: NonNullable<PaypalAgentResult['connection']>,
) {
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
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
  if (!row || Object.keys(row).sort().join(',') !== 'key,model,pending,url')
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
    typeof row.pending !== 'boolean'
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
  return { url: row.url, key: row.key, model: row.model, pending: row.pending };
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
