// Validates the desktop's local sandbox agent connection details at the IPC boundary.
import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
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
  RESPONSE_DRAIN_MS: 10_000,
} as const;
export const PAYPAL_AGENT_ACTION = {
  STATUS: 'status',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
} as const;
export const PAYPAL_AGENT_ERROR = {
  DENIED: 'denied',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
  MODEL_UNAVAILABLE: 'model_unavailable',
  NEW_SESSION_REQUIRED: 'new_session_required',
} as const;
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
    return `Check that ${DESKTOP_PAYPAL_AGENT.MODEL} is installed in Ollama. Settle this session in Chat, restart Gyblos, and start a new session.`;
  if (error === PAYPAL_AGENT_ERROR.NEW_SESSION_REQUIRED)
    return 'Settle the current session in Chat and start a new one to connect the agent.';
  return 'Check that a PayPal Sandbox session is active in Chat, then try again.';
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
  } | null;
  error: (typeof PAYPAL_AGENT_ERROR)[keyof typeof PAYPAL_AGENT_ERROR] | null;
};
export function opencodeConfig(
  connection: Pick<
    NonNullable<PaypalAgentResult['connection']>,
    'url' | 'key' | 'model'
  >,
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
export function retainPaypalAgentStatus(
  previous: PaypalAgentResult,
  next: PaypalAgentResult | undefined,
) {
  if (!next || next.error) return { result: previous, unavailable: true };
  return { result: next, unavailable: false };
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
      'disconnecting,key,limitCents,model,spentCents,url,usageUncertain'
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
    row.limitCents !== PAYPAL_SANDBOX.limitCents ||
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
