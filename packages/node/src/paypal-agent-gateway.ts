// Authenticated local agent requests sharing one sandbox session. Responses are buffered;
// Completed inferences are charged before their buffered results are returned.
import { timingSafeEqual } from 'node:crypto';

import { HTTP_STATUS, IPV6_LOOPBACK, LOCALHOST, ROUTES } from '@gyblos/config';
import { AGENT_CHAT, PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaypalError,
  type PaypalErrorCode,
} from '@gyblos/protocol/paypal-payment';

import { PAYPAL_AGENT_REQUEST_LIMITS } from './constants';
import {
  validatePaypalAgentRequest,
  validatePaypalAgentResult,
} from './paypal-agent-validation';

interface AgentService {
  sendAgent(
    input: unknown,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<{ response: unknown; messageId: string }>;
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
      headers: {
        'x-should-retry': code === PAYPAL_ERROR_CODES.BUSY ? 'true' : 'false',
        'cache-control': 'no-store',
      },
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
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(PAYPAL_AGENT_REQUEST_LIMITS.bodyReadMs),
  ]);
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST));
    signal.addEventListener('abort', abort, { once: true });
  });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await Promise.race([reader.read(), aborted]);
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
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
  }
}

function answer(result: Record<string, unknown>) {
  if (!Array.isArray(result.choices) || result.choices.length !== 1)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return record(record(result.choices[0]).message);
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
    reason instanceof PaypalError
      ? reason.code
      : PAYPAL_ERROR_CODES.UNAVAILABLE;
  return error(
    code === PAYPAL_ERROR_CODES.BUSY
      ? HTTP_STATUS.conflict
      : HTTP_STATUS.badRequest,
    code,
  );
}

function modelList(model: string) {
  return Response.json(
    {
      object: AGENT_CHAT.LIST,
      data: [
        { id: model, object: AGENT_CHAT.MODEL, created: 0, owned_by: 'gyblos' },
      ],
    },
    { headers: { 'cache-control': 'no-store' } },
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
  if (request.method === 'GET' && url.pathname === ROUTES.models && !url.search)
    return undefined;
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
  let reading = false;
  async function handle(request: Request) {
    const rejection = requestError(request, base, key);
    if (rejection) return rejection;
    if (request.method === 'GET') return modelList(options.model);
    if (busy || reading)
      return error(HTTP_STATUS.conflict, PAYPAL_ERROR_CODES.BUSY);
    let input: Record<string, unknown>;
    reading = true;
    try {
      input = validatePaypalAgentRequest(await body(request), options.model);
    } catch (reason) {
      return agentError(reason);
    } finally {
      reading = false;
    }
    if (busy) return error(HTTP_STATUS.conflict, PAYPAL_ERROR_CODES.BUSY);
    busy = true;
    try {
      const idempotencyKey =
        request.headers.get('idempotency-key') ?? undefined;
      if (
        idempotencyKey !== undefined &&
        (idempotencyKey.length >
          PAYPAL_AGENT_REQUEST_LIMITS.idempotencyKeyCharacters ||
          !/^[A-Za-z0-9._~-]+$/.test(idempotencyKey))
      )
        throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
      const result = await options.service.sendAgent(
        input,
        request.signal,
        idempotencyKey,
      );
      if (typeof input.max_tokens !== 'number')
        throw new Error('Invalid output limit.');
      const response = validatePaypalAgentResult(
        result.response,
        options.model,
        input.max_tokens,
        input,
      );
      return agentResponse(input, response);
    } catch (reason) {
      return agentError(reason);
    } finally {
      busy = false;
    }
  }
  return {
    handle,
    isBusy: () => busy || reading,
  };
}
