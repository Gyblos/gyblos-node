// Authenticated local agent requests sharing one sandbox session. Responses are buffered;
// an echoed assistant message acknowledges a prior result, not payment by itself.
import { createHash, timingSafeEqual } from 'node:crypto';

import { HTTP_STATUS, IPV6_LOOPBACK, LOCALHOST, ROUTES } from '@gyblos/config';
import { AGENT_CHAT, PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaypalError,
  type PaypalErrorCode,
} from '@gyblos/protocol/paypal-payment';

import { PAYPAL_AGENT_REQUEST_LIMITS, PAYPAL_SESSION_PHASE } from './constants';
import {
  validatePaypalAgentRequest,
  validatePaypalAgentResult,
} from './paypal-agent-validation';

interface AgentService {
  status(): { phase: unknown };
  sendAgent(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ response: unknown; messageId: string }>;
  acknowledge(messageId: string): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return Object.fromEntries(Object.entries(value));
}

function error(status: number, code: PaypalErrorCode) {
  return Response.json(
    { error: { message: code, type: 'invalid_request_error', code } },
    {
      status,
      headers: { 'x-should-retry': 'false', 'cache-control': 'no-store' },
    },
  );
}

function matchesKey(header: string | null, key: Buffer) {
  if (!header?.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(header.slice('Bearer '.length));
  return candidate.length === key.length && timingSafeEqual(candidate, key);
}

async function body(request: Request) {
  const declared = request.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) ||
      Number(declared) > PAYPAL_AGENT_REQUEST_LIMITS.requestBytes)
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  if (!request.body) throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > PAYPAL_AGENT_REQUEST_LIMITS.requestBytes)
        throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
      parts.push(part.value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(parts),
    );
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch {
      throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function assistant(value: unknown) {
  const row = record(value);
  if (row.role !== AGENT_CHAT.ROLES.ASSISTANT) return undefined;
  return JSON.stringify({
    role: row.role,
    content: row.content,
    tool_calls: row.tool_calls,
  });
}

function answer(result: Record<string, unknown>) {
  if (!Array.isArray(result.choices) || result.choices.length !== 1)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return record(record(result.choices[0]).message);
}

function fingerprint(value: unknown) {
  const text = assistant(value);
  if (!text) throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return createHash('sha256').update(text).digest('hex');
}

function fingerprintCount(messages: unknown, target: string) {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const item of messages) {
    try {
      if (fingerprint(item) === target) count += 1;
    } catch {
      continue;
    }
  }
  return count;
}

function eventStream(result: Record<string, unknown>, includeUsage: boolean) {
  const choice = record(
    Array.isArray(result.choices) ? result.choices[0] : undefined,
  );
  const message = answer(result);
  const delta = { ...message };
  if (Array.isArray(delta.tool_calls))
    delta.tool_calls = delta.tool_calls.map((call, index) => ({
      ...record(call),
      index,
    }));
  const common = {
    id: result.id,
    object: AGENT_CHAT.CHUNK,
    created: result.created,
    model: result.model,
  };
  const chunks = [
    { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...common,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
    },
    ...(includeUsage ? [{ ...common, choices: [], usage: result.usage }] : []),
  ];
  const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: ${AGENT_CHAT.STREAM_DONE}\n\n`;
  return new Response(text, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
    },
  });
}

function agentResponse(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const streamOptions =
    input.stream_options === undefined ? {} : record(input.stream_options);
  return input.stream === true
    ? eventStream(result, streamOptions.include_usage === true)
    : Response.json(result, { headers: { 'cache-control': 'no-store' } });
}

function agentError(reason: unknown) {
  const code =
    reason instanceof PaypalError ? reason.code : PAYPAL_ERROR_CODES.UNAVAILABLE;
  return error(
    code === PAYPAL_ERROR_CODES.INVALID_REQUEST
      ? HTTP_STATUS.badRequest
      : HTTP_STATUS.conflict,
    code,
  );
}

interface GatewayOptions {
  origin: string;
  key: string;
  model: string;
  service: AgentService;
}
function gatewayOrigin(options: GatewayOptions) {
  const base = new URL(options.origin);
  if (
    base.protocol !== 'http:' ||
    ![LOCALHOST, IPV6_LOOPBACK].includes(base.hostname) ||
    !base.port ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    !options.key
  )
    throw new Error('Invalid local agent gateway configuration.');
  return base;
}
function requestError(request: Request, base: URL, key: Buffer) {
  const url = new URL(request.url);
  if (
    url.origin !== base.origin ||
    request.headers.get('host') !== base.host ||
    request.headers.has('origin')
  )
    return error(HTTP_STATUS.forbidden, PAYPAL_ERROR_CODES.INVALID_REQUEST);
  if (!matchesKey(request.headers.get('authorization'), key))
    return error(HTTP_STATUS.unauthorized, PAYPAL_ERROR_CODES.INVALID_REQUEST);
  if (
    request.method !== 'POST' ||
    url.pathname !== ROUTES.inference ||
    url.search
  )
    return error(HTTP_STATUS.notFound, PAYPAL_ERROR_CODES.INVALID_REQUEST);
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  )
    return error(HTTP_STATUS.badRequest, PAYPAL_ERROR_CODES.INVALID_REQUEST);
  return undefined;
}
export function createPaypalAgentGateway(options: GatewayOptions) {
  const base = gatewayOrigin(options);
  const key = Buffer.from(options.key);
  let busy = false;
  let pending:
    | { messageId: string; fingerprint: string; previousCount: number }
    | undefined;
  async function acknowledgePending() {
    if (busy || !pending) throw new Error('No agent response is available.');
    busy = true;
    try {
      await options.service.acknowledge(pending.messageId);
      pending = undefined;
    } finally {
      busy = false;
    }
  }
  async function handle(request: Request) {
    const rejection = requestError(request, base, key);
    if (rejection) return rejection;
    if (busy)
      return error(
        HTTP_STATUS.conflict,
        PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION,
      );
    busy = true;
    try {
      const input = validatePaypalAgentRequest(
        await body(request),
        options.model,
      );
      if (
        pending &&
        options.service.status().phase !== PAYPAL_SESSION_PHASE.MESSAGE_PENDING
      )
        pending = undefined;
      if (pending) {
        if (
          fingerprintCount(input.messages, pending.fingerprint) <=
          pending.previousCount
        )
          return error(
            HTTP_STATUS.conflict,
            PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION,
          );
        await options.service.acknowledge(pending.messageId);
        pending = undefined;
      }
      const result = await options.service.sendAgent(input, request.signal);
      if (typeof input.max_tokens !== 'number')
        throw new Error('Invalid output limit.');
      const response = validatePaypalAgentResult(
        result.response,
        options.model,
        input.max_tokens,
        input,
      );
      const responseFingerprint = fingerprint(answer(response));
      pending = {
        messageId: result.messageId,
        fingerprint: responseFingerprint,
        previousCount: fingerprintCount(input.messages, responseFingerprint),
      };
      return agentResponse(input, response);
    } catch (reason) {
      return agentError(reason);
    } finally {
      busy = false;
    }
  }
  return { handle, acknowledgePending };
}
