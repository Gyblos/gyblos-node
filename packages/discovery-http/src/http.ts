// Owns safe index URLs, the injected fetch with a deadline and bounded incremental body reads.
// It must not verify records or touch the global fetch; failures surface as static DiscoveryError codes.
import { LOOPBACK_HOST_NAMES } from '@gyblos/config';

import {
  DISCOVERY_ERROR_CODES,
  DISCOVERY_LIMITS,
  type DiscoveryErrorCode,
} from './constants.js';
import { DiscoveryError, discoveryFail } from './errors.js';

export type DiscoveryFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(LOOPBACK_HOST_NAMES);
const HTTPS_PROTOCOL = 'https:';
const LOOPBACK_PROTOCOL = 'http:';

// Accepts https, or http only on a loopback host (local tests and a self-run index).
export function indexUrl(baseUrl: unknown, path: string, query = ''): string {
  if (typeof baseUrl !== 'string')
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  }
  if (base.username || base.password || base.search || base.hash)
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const secure =
    base.protocol === HTTPS_PROTOCOL ||
    (base.protocol === LOOPBACK_PROTOCOL && LOOPBACK_HOSTS.has(base.hostname));
  if (!secure) discoveryFail(DISCOVERY_ERROR_CODES.INSECURE_URL);
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}${query}`;
}

export function timeoutOf(value: unknown): number {
  if (value === undefined) return DISCOVERY_LIMITS.defaultTimeoutMs;
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== 'number' ||
    value < 1 ||
    value > DISCOVERY_LIMITS.maxTimeoutMs
  )
    return discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  return value;
}

export interface DeadlineRequest {
  url: string;
  init: RequestInit;
  fetch: DiscoveryFetch;
  timeoutMs: number;
}

// Runs one request under a deadline; `read` consumes the response before the deadline ends.
export async function withDeadline<T>(
  request: DeadlineRequest,
  read: (response: Response, aborted: Promise<never>) => Promise<T>,
): Promise<T> {
  if (typeof request.fetch !== 'function')
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const controller = new AbortController();
  let expire = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new DiscoveryError(DISCOVERY_ERROR_CODES.TIMEOUT));
  });
  // Callers may never await `aborted`; keep its rejection observed.
  aborted.catch(() => {});
  const timer = setTimeout(() => {
    controller.abort();
    expire();
  }, request.timeoutMs);
  try {
    const response = await Promise.race([
      send(request, controller.signal),
      aborted,
    ]);
    return await read(response, aborted);
  } finally {
    clearTimeout(timer);
  }
}

async function send(request: DeadlineRequest, signal: AbortSignal) {
  let response: unknown;
  try {
    response = await request.fetch(request.url, {
      ...request.init,
      signal,
      redirect: 'error',
    });
  } catch (error) {
    throw new DiscoveryError(
      signal.aborted
        ? DISCOVERY_ERROR_CODES.TIMEOUT
        : DISCOVERY_ERROR_CODES.NETWORK,
      undefined,
      { cause: error },
    );
  }
  if (!(response instanceof Response))
    return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
  return response;
}

// Releases an unread body without waiting on a peer that may never finish.
export function discard(response: Response) {
  response.body?.cancel().catch(() => {});
}

// Reads at most `maxBytes`, chunk by chunk, then decodes strict UTF-8 and parses JSON as unknown.
export async function readJson(
  response: Response,
  maxBytes: number,
  aborted: Promise<never>,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    discard(response);
    discoveryFail(DISCOVERY_ERROR_CODES.RESPONSE_TOO_LARGE, response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes)
        discoveryFail(
          DISCOVERY_ERROR_CODES.RESPONSE_TOO_LARGE,
          response.status,
        );
      chunks.push(chunk.value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof DiscoveryError) throw error;
    return discoveryFail(DISCOVERY_ERROR_CODES.NETWORK, response.status);
  }
  return parseBody(chunks, total, response.status);
}

function parseBody(chunks: Uint8Array[], total: number, status: number) {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE, status);
  }
}

export function failStatus(
  response: Response,
  code: DiscoveryErrorCode,
): never {
  discard(response);
  return discoveryFail(code, response.status);
}

export function isPlainObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}
