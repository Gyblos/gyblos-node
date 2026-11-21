// The public devnet RPC limits requests per IP and answers HTTP 429 when a seller goes over. Failing at once
// then fails a buyer's channel for a limit that clears in seconds, so the seller waits what Retry-After asks
// (or backs off), within a small bounded budget, and tries again. Only 429 is retried: any other answer or
// failure passes through untouched, and a cancelled request is never sent again. A provider refuses a
// limited request before processing it, and the same signed transaction sent twice has one signature, so a
// retried send cannot pay twice.
import { setTimeout as delay } from 'node:timers/promises';

import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type RpcTransport,
} from '@solana/kit';
import type { FacilitatorRpcClient } from '@x402/svm';

import { HTTP_STATUS, UNITS } from '@gyblos/config';

export const RPC_RATE_LIMIT = {
  retries: 3,
  baseMs: 500,
  // One wait, and all waits of one request: kept well inside a seller's 20 s operation bound.
  maxWaitMs: 4_000,
  budgetMs: 8_000,
} as const;

export interface RateLimitOptions {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Wall clock for an HTTP-date Retry-After.
  now?: () => number;
}

const SECONDS = /^\d+$/;

// Retry-After as delay seconds or an HTTP date; without one (or unreadable), exponential backoff.
function waitMs(
  retryAfter: string | null | undefined,
  attempt: number,
  now: () => number,
) {
  const value = retryAfter?.trim() ?? '';
  let ms = RPC_RATE_LIMIT.baseMs * 2 ** attempt;
  if (SECONDS.test(value)) ms = Number(value) * UNITS.millisecondsPerSecond;
  else if (value) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) ms = Math.max(0, at - now());
  }
  return Math.min(ms, RPC_RATE_LIMIT.maxWaitMs);
}

const sleepFor = async (ms: number, signal?: AbortSignal) => {
  await delay(ms, undefined, signal ? { signal } : undefined);
};

// Runs `send` again while `limitedBy` names a Retry-After (a 429), inside the retry count and wait budget.
async function retrying<T>(
  send: () => Promise<T>,
  limitedBy: (outcome: { value?: T; error?: unknown }) => string | null | false,
  options: RateLimitOptions,
  signal?: AbortSignal,
  release?: (value: T) => void,
) {
  const sleep = options.sleep ?? sleepFor;
  const now = options.now ?? Date.now;
  let spent = 0;
  for (let attempt = 0; ; attempt += 1) {
    let outcome: { value?: T; error?: unknown };
    try {
      outcome = { value: await send() };
    } catch (error) {
      outcome = { error };
    }
    const retryAfter = limitedBy(outcome);
    const wait = retryAfter === false ? 0 : waitMs(retryAfter, attempt, now);
    if (
      retryAfter === false ||
      attempt >= RPC_RATE_LIMIT.retries ||
      spent + wait > RPC_RATE_LIMIT.budgetMs ||
      signal?.aborted
    ) {
      if ('error' in outcome) throw outcome.error;
      return outcome.value as T;
    }
    if (release && 'value' in outcome) release(outcome.value as T);
    spent += wait;
    await sleep(wait, signal);
    signal?.throwIfAborted();
  }
}

const isLimited = (error: unknown) =>
  isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
  error.context.statusCode === HTTP_STATUS.tooManyRequests;

export function rateLimitedTransport(
  inner: RpcTransport,
  options: RateLimitOptions = {},
): RpcTransport {
  return (<TResponse>(request: Parameters<RpcTransport>[0]) =>
    retrying<TResponse>(
      () => inner<TResponse>(request),
      ({ error }) =>
        isLimited(error)
          ? ((error as { context: { headers?: Headers } }).context.headers?.get(
              'retry-after',
            ) ?? null)
          : false,
      options,
      request.signal,
    )) as RpcTransport;
}

export type RateLimitedFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export function rateLimitedFetch(
  fetcher: RateLimitedFetch,
  options: RateLimitOptions = {},
): RateLimitedFetch {
  return (input, init) =>
    retrying(
      () => fetcher(input, init),
      ({ value }) =>
        value?.status === HTTP_STATUS.tooManyRequests
          ? value.headers.get('retry-after')
          : false,
      options,
      init.signal ?? undefined,
      (response) => {
        response.body?.cancel().catch(() => {});
      },
    );
}

// A Solana RPC client for the seller that rides out 429s; a drop-in for createSolanaRpc(url).
export const rateLimitedSolanaRpc = (url: string) =>
  createSolanaRpcFromTransport(
    rateLimitedTransport(createDefaultRpcTransport({ url })),
  );

// The SDK's facilitator signer, on the same client. It recognises a single client only by `in` checks a
// @solana/kit RPC proxy does not answer, so the client goes in as the map entry used for every network,
// as `defaultRpcUrl` did.
export const rateLimitedFacilitatorRpc = (
  url: string,
): Record<string, FacilitatorRpcClient> => ({
  '*': rateLimitedSolanaRpc(url) as FacilitatorRpcClient,
});
