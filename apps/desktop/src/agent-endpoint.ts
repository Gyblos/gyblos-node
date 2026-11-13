// Reads only the connected buyer's authenticated public model metadata, with bounded I/O.
// Never consults discovery directly, substitutes a model, or returns the buyer credential.
import { ROUTES } from '@gyblos/config';
import {
  AGENT_SETUP,
  AGENT_SETUP_CODES,
  AgentSetupError,
  opencodeProvider,
  type AgentEndpoint,
} from '@gyblos/node/agent-setup';
import { bounded } from '@gyblos/node/buyer-operation';

import { DESKTOP_X402, USDC_AGENT_SETUP } from './x402/constants';

function models(value: unknown): AgentEndpoint['models'] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('object' in value) ||
    value.object !== 'list' ||
    !('data' in value) ||
    !Array.isArray(value.data) ||
    !value.data.length ||
    value.data.length > AGENT_SETUP.maxModels
  )
    throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
  const result = value.data.map((row: unknown) => {
    if (
      !row ||
      typeof row !== 'object' ||
      !('id' in row) ||
      typeof row.id !== 'string' ||
      !('max_output_tokens' in row) ||
      typeof row.max_output_tokens !== 'number'
    )
      throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
    return { id: row.id, maxOutputTokens: row.max_output_tokens };
  });
  if (new Set(result.map((row) => row.id)).size !== result.length)
    throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
  return result;
}
export async function requestAgentEndpoint(
  connection: { url: URL; token: string },
  request: typeof fetch,
  signal: AbortSignal,
): Promise<AgentEndpoint> {
  const current = AbortSignal.any([
    signal,
    AbortSignal.timeout(DESKTOP_X402.STATUS_MS),
  ]);
  try {
    const response = await bounded(
      request(new URL(`${ROUTES.agentBase}/models`, connection.url), {
        headers: { authorization: `Bearer ${connection.token}` },
        redirect: 'error',
        signal: current,
      }),
      current,
    );
    if (!response.ok || !response.body)
      throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await bounded(reader.read(), current);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > DESKTOP_X402.MAX_RESPONSE)
          throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
        parts.push(next.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    current.throwIfAborted();
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
    );
    const endpoint = {
      origin: connection.url.origin,
      models: models(value),
      tokenEnv: USDC_AGENT_SETUP.tokenEnv,
    };
    opencodeProvider(endpoint); // the same public validation every generator uses
    return endpoint;
  } catch {
    throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
  }
}
