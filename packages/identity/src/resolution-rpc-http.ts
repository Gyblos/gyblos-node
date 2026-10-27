// Bounds decoded fetch bodies under an absolute deadline before any SDK parser runs.
// Cancellation discards late work without awaiting a potentially uncooperative provider.
import { IDENTITY_ERROR_CODES } from './constants.js';
import { IdentityError, identityRpcFail } from './errors.js';
import type { IdentityRpcConfig } from './resolution-rpc-options.js';

function discard(response: Response) {
  response.body?.cancel().catch(() => {});
}
function abortPromise(signal: AbortSignal) {
  let abort = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        new IdentityError(
          IDENTITY_ERROR_CODES.RPC_CANCELLED,
          IDENTITY_ERROR_CODES.RPC_CANCELLED,
        ),
      );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  // A synchronous failure before the first race must not leave an unobserved rejection.
  promise.catch(() => {});
  return { promise, close: () => signal.removeEventListener('abort', abort) };
}
function active(signal: AbortSignal, deadline: number) {
  if (signal.aborted)
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_CANCELLED);
  if (performance.now() >= deadline)
    return identityRpcFail(IDENTITY_ERROR_CODES.READ_TIMEOUT);
}
async function send(
  config: IdentityRpcConfig,
  body: string,
  signal: AbortSignal,
) {
  const response = await config.fetch(config.url, {
    method: 'POST',
    body,
    signal,
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
    },
  });
  if (!(response instanceof Response))
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_RESPONSE_INVALID);
  if (signal.aborted) {
    discard(response);
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_CANCELLED);
  }
  if (!response.ok) {
    discard(response);
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_TRANSPORT_FAILED);
  }
  return response;
}
async function read(
  response: Response,
  config: IdentityRpcConfig,
  signal: AbortSignal,
  deadline: number,
  aborted: Promise<never>,
) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > config.maxResponseBytes) {
    discard(response);
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_RESPONSE_TOO_LARGE);
  }
  const reader = response.body?.getReader();
  if (!reader)
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_RESPONSE_INVALID);
  // Fixed storage bounds chunk overhead too, including arbitrarily fragmented/empty chunks.
  const bytes = new Uint8Array(config.maxResponseBytes);
  let size = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      active(signal, deadline);
      if (chunk.done) break;
      if (chunk.value.byteLength > config.maxResponseBytes - size)
        return identityRpcFail(IDENTITY_ERROR_CODES.RPC_RESPONSE_TOO_LARGE);
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, size),
    );
  } catch (error) {
    reader.cancel().catch(() => {});
    if (error instanceof IdentityError) throw error;
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_RESPONSE_INVALID);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* A nonconforming pending reader must not delay refusal. */
    }
  }
}
export async function readIdentityRpcResponse(
  config: IdentityRpcConfig,
  body: string,
  external: AbortSignal | undefined,
  parse: (text: string) => unknown,
): Promise<unknown> {
  const lifetime = new AbortController();
  const deadline = performance.now() + config.timeoutMs;
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = AbortSignal.any([
    lifetime.signal,
    timeout,
    ...(external ? [external] : []),
  ]);
  const aborted = abortPromise(signal);
  try {
    active(signal, deadline);
    const response = await Promise.race([
      send(config, body, signal),
      aborted.promise,
    ]);
    active(signal, deadline);
    const text = await read(
      response,
      config,
      signal,
      deadline,
      aborted.promise,
    );
    active(signal, deadline);
    const value = parse(text);
    active(signal, deadline);
    return value;
  } catch (error) {
    if (external?.aborted)
      return identityRpcFail(IDENTITY_ERROR_CODES.RPC_CANCELLED);
    if (timeout.aborted || performance.now() >= deadline)
      return identityRpcFail(IDENTITY_ERROR_CODES.READ_TIMEOUT);
    if (error instanceof IdentityError) throw error;
    return identityRpcFail(IDENTITY_ERROR_CODES.RPC_TRANSPORT_FAILED);
  } finally {
    aborted.close();
    lifetime.abort();
  }
}
