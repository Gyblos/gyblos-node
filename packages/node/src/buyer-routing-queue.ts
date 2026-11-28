// One bounded in-memory waiter per seller; waiting never opens channels or stores request content.
import { setTimeout as delay } from 'node:timers/promises';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { BUYER_ROUTING_DEFAULTS } from '@gyblos/config/buyer-routing';
import { BuyerRoutingError } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';

interface Waiter {
  owner: symbol;
  signal: AbortSignal;
  finish(error?: unknown): void;
}
export interface BuyerWaitScope {
  signal: AbortSignal;
  dispose(): void;
}
export function createBuyerQueue(owners: Map<string, symbol>) {
  const waiters = new Map<string, Waiter>();
  const scopes = new Map<AbortController, () => void>();
  return {
    scope(external: AbortSignal, waitMs: number): BuyerWaitScope {
      const controller = new AbortController();
      const timer = setTimeout(
        () =>
          controller.abort(
            new BuyerRoutingError(BUYER_ROUTING_CODES.QUEUE_TIMEOUT),
          ),
        waitMs,
      );
      const dispose = () => {
        clearTimeout(timer);
        scopes.delete(controller);
      };
      scopes.set(controller, dispose);
      return {
        signal: AbortSignal.any([external, controller.signal]),
        dispose,
      };
    },
    async acquire(nodeId: string, owner: symbol, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!owners.has(nodeId) || owners.get(nodeId) === owner) {
        owners.set(nodeId, owner);
        return;
      }
      if (waiters.has(nodeId) || waiters.size >= TRANSPORT_LIMITS.maxConcurrent)
        throw new BuyerRoutingError(BUYER_ROUTING_CODES.BUSY);
      return new Promise<void>((resolve, reject) => {
        const abort = () => waiting.finish(signal.reason);
        const waiting: Waiter = {
          owner,
          signal,
          finish(error) {
            if (waiters.get(nodeId) !== waiting) return;
            waiters.delete(nodeId);
            signal.removeEventListener('abort', abort);
            if (error !== undefined) reject(error);
            else resolve();
          },
        };
        waiters.set(nodeId, waiting);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    release(nodeId: string, owner: symbol) {
      if (owners.get(nodeId) !== owner) return;
      owners.delete(nodeId);
      const waiting = waiters.get(nodeId);
      if (waiting) {
        if (waiting.signal.aborted) waiting.finish(waiting.signal.reason);
        else {
          owners.set(nodeId, waiting.owner);
          waiting.finish();
        }
      }
    },
    cancel(reason: unknown) {
      for (const controller of scopes.keys()) controller.abort(reason);
      for (const waiting of [...waiters.values()]) waiting.finish(reason);
    },
    dispose() {
      for (const dispose of [...scopes.values()]) dispose();
    },
  };
}

export function createQuoteQueue() {
  const selections = new Map<string | undefined, Promise<unknown>>();
  return {
    run<T>(scope: string | undefined, select: () => Promise<T>) {
      const previous = selections.get(scope) ?? Promise.resolve();
      const running = previous.then(select, select);
      selections.set(scope, running);
      const clear = () => {
        if (selections.get(scope) === running) selections.delete(scope);
      };
      void running.then(clear, clear);
      return running;
    },
    drain: () => Promise.allSettled(selections.values()),
  };
}

export async function waitForRemoteSeller(signal: AbortSignal) {
  try {
    await delay(BUYER_ROUTING_DEFAULTS.queuePollMs, undefined, { signal });
  } catch {
    signal.throwIfAborted();
  }
}
