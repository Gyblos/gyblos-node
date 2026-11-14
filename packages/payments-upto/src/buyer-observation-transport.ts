// Bounds and validates finalized buyer-observation RPC responses before SDK parsing.
import { createSolanaRpcFromTransport, type RpcTransport } from '@solana/kit';
import {
  parseJsonWithBigInts,
  stringifyJsonWithBigInts,
} from '@solana/rpc-spec-types';

import { TIMEOUTS } from '@gyblos/config';
import {
  PAYMENT_ERROR_CODES,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import { beforeAbort } from './buyer-observation-rpc';
import {
  BUYER_OBSERVATION,
  BUYER_OBSERVATION_RPC_METHODS,
  BUYER_RECOVERY_RPC_METHODS,
} from './constants';

export type BuyerObservationFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
function invalid(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE);
}
type BuyerRpcMethod = (typeof BUYER_RECOVERY_RPC_METHODS)[number];
function requestId(
  payload: unknown,
  methods: readonly BuyerRpcMethod[],
): string {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('id' in payload) ||
    typeof payload.id !== 'string' ||
    !('jsonrpc' in payload) ||
    payload.jsonrpc !== '2.0' ||
    !('method' in payload) ||
    typeof payload.method !== 'string' ||
    !methods.some((method) => method === payload.method)
  )
    return invalid();
  return payload.id;
}
function active(
  signal: AbortSignal,
  deadline: number,
  now: () => number,
): void {
  const time = now();
  if (signal.aborted || !Number.isFinite(time) || time >= deadline) invalid();
}
async function bodyText(
  response: Response,
  signal: AbortSignal,
  deadline: number,
  now: () => number,
): Promise<string> {
  const limit = BUYER_OBSERVATION.maxResponseBytes;
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > limit) return invalid();
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const bytes = new Uint8Array(limit);
  let used = 0;
  try {
    for (;;) {
      active(signal, deadline, now);
      const chunk = await beforeAbort(signal, () => reader.read());
      active(signal, deadline, now);
      if (chunk.done) break;
      if (chunk.value.byteLength > limit - used) return invalid();
      bytes.set(chunk.value, used);
      used += chunk.value.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, used),
    );
  } finally {
    reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* A cancelled reader may still be pending. */
    }
  }
}
function tokenBalances(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || !('meta' in value)) return false;
  const meta = value.meta;
  if (meta === null) return true;
  if (
    !meta ||
    typeof meta !== 'object' ||
    !('preTokenBalances' in meta) ||
    !('postTokenBalances' in meta)
  )
    return false;
  return [meta.preTokenBalances, meta.postTokenBalances].every(
    (balances) =>
      Array.isArray(balances) &&
      balances.every((balance: unknown) => {
        if (
          !balance ||
          typeof balance !== 'object' ||
          !('uiTokenAmount' in balance)
        )
          return false;
        const amount = balance.uiTokenAmount;
        if (
          !amount ||
          typeof amount !== 'object' ||
          !('amount' in amount) ||
          typeof amount.amount !== 'string'
        )
          return false;
        return (
          amount.amount.length <= PUBLIC_RECORD_LIMITS.maxAtomicDigits &&
          /^(0|[1-9][0-9]*)$/.test(amount.amount) &&
          BigInt(amount.amount) <= BigInt(PUBLIC_RECORD_LIMITS.maxAtomic)
        );
      }),
  );
}
function envelope(text: string, id: string, method: string): unknown {
  const value: unknown = parseJsonWithBigInts(text);
  if (
    !value ||
    typeof value !== 'object' ||
    !('jsonrpc' in value) ||
    value.jsonrpc !== '2.0' ||
    !('id' in value) ||
    value.id !== id ||
    !('result' in value) ||
    !Object.hasOwn(value, 'result') ||
    Object.hasOwn(value, 'error')
  )
    return invalid();
  if (method === 'getTransaction' && !tokenBalances(value.result))
    return invalid();
  return value;
}
export function createBuyerObservationRpc(
  url: string,
  fetcher: BuyerObservationFetch = globalThis.fetch,
  now: () => number = () => performance.now(),
) {
  return boundedRpc(url, fetcher, now, BUYER_OBSERVATION_RPC_METHODS);
}
export function createBuyerRecoveryRpc(url: string) {
  return boundedRpc(
    url,
    globalThis.fetch,
    () => performance.now(),
    BUYER_RECOVERY_RPC_METHODS,
  );
}
function boundedRpc(
  url: string,
  fetcher: BuyerObservationFetch,
  now: () => number,
  methods: readonly BuyerRpcMethod[],
) {
  function transport<TResponse>(
    request: Parameters<RpcTransport>[0],
  ): Promise<TResponse>;
  async function transport({
    payload,
    signal: external,
  }: Parameters<RpcTransport>[0]): Promise<unknown> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(TIMEOUTS.rpc),
      ...(external ? [external] : []),
    ]);
    let response: Response | undefined;
    try {
      const deadline = now() + TIMEOUTS.rpc;
      if (!Number.isFinite(deadline)) return invalid();
      active(signal, deadline, now);
      const id = requestId(payload, methods);
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('method' in payload) ||
        typeof payload.method !== 'string'
      )
        return invalid();
      response = await beforeAbort(signal, () => {
        const pending = fetcher(url, {
          method: 'POST',
          body: stringifyJsonWithBigInts(payload),
          signal,
          redirect: 'error',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json; charset=utf-8',
          },
        });
        void pending.then(
          (late) => {
            if (late instanceof Response && signal.aborted)
              late.body?.cancel().catch(() => {});
          },
          () => {},
        );
        return pending;
      });
      if (!(response instanceof Response) || !response.ok || signal.aborted)
        return invalid();
      active(signal, deadline, now);
      const text = await bodyText(response, signal, deadline, now);
      active(signal, deadline, now);
      const result = envelope(text, id, payload.method);
      active(signal, deadline, now);
      return result;
    } catch {
      return invalid();
    } finally {
      response?.body?.cancel().catch(() => {});
    }
  }
  return createSolanaRpcFromTransport(transport);
}
