// Routes authenticated pilot buyers to separate financial hosts while preserving one global foreground turn.
import {
  batchSessionTerminal,
  type BatchSellerRegistry,
} from '@gyblos/payments-upto/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_METHODS,
  batchError,
  batchFail,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { controlHex } from '@gyblos/protocol/control-validation';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import {
  startSellerSessions,
  type SellerSessionHost,
  type SellerSessionOptions,
} from './seller-sessions';

export type SellerSessionComposition =
  | Pick<SellerSessionOptions, 'buyerNodeId' | 'backend'>
  | { buyerNodeIds: readonly string[]; registry: BatchSellerRegistry };
type Common = Omit<SellerSessionOptions, 'buyerNodeId' | 'backend'>;
type Options = Common & SellerSessionComposition;
interface State {
  options: Common & {
    buyerNodeIds: readonly string[];
    registry: BatchSellerRegistry;
  };
  allowed: Set<string>;
  known: Set<string>;
  hosts: Map<string, SellerSessionHost>;
  active?: Promise<unknown>;
  closed: boolean;
}
async function host(state: State, peer: string) {
  let current = state.hosts.get(peer);
  if (!current) {
    current = await startSellerSessions({
      ...state.options,
      buyerNodeId: peer,
      backend: state.options.registry.backend(peer),
    });
    state.hosts.set(peer, current);
  }
  return current;
}
async function admission(
  state: State,
  request: BatchChannelRequest,
  peer: string,
) {
  if (!state.allowed.has(peer)) {
    if (
      !state.known.has(peer) ||
      request.method === BATCH_METHODS.PREPARE ||
      request.method === BATCH_METHODS.EXECUTE
    )
      return batchFail(PAID_EXECUTION_CODES.PEER);
    if (request.method === BATCH_METHODS.OPEN) {
      const old = await state.options.registry.backend(peer).inspect();
      if (
        !old ||
        canonicalJson(request.params.terms ?? old.terms) !==
          canonicalJson(old.terms)
      )
        return batchFail(PAID_EXECUTION_CODES.PEER);
    }
  }
  if (
    request.method === BATCH_METHODS.PREPARE ||
    request.method === BATCH_METHODS.OPEN
  ) {
    const old = state.known.has(peer)
      ? await state.options.registry.backend(peer).inspect()
      : undefined;
    const restores =
      request.method === BATCH_METHODS.OPEN &&
      old &&
      canonicalJson(request.params.terms ?? old.terms) ===
        canonicalJson(old.terms);
    if (!restores && !(await state.options.registry.permits(peer)))
      return batchFail(SESSION_CODES.BUSY);
  }
}
async function run<T>(
  state: State,
  peer: string,
  signal: AbortSignal,
  execute: () => Promise<T>,
) {
  if (state.closed) return batchFail(SESSION_CODES.UNAVAILABLE);
  if (!state.allowed.has(peer) && !state.known.has(peer))
    return batchFail(PAID_EXECUTION_CODES.PEER);
  if (state.active) return batchFail(SESSION_CODES.BUSY);
  signal.throwIfAborted();
  const operation = Promise.resolve().then(execute);
  state.active = operation;
  try {
    return await operation;
  } catch (error) {
    throw batchError(error);
  } finally {
    state.active = undefined;
  }
}
async function close(state: State) {
  state.closed = true;
  await state.active?.catch(() => {});
  await Promise.allSettled(
    [...state.hosts.values()].map((current) => current.close()),
  );
}
export async function startSellerSessionHost(
  options: Options,
): Promise<SellerSessionHost> {
  if ('buyerNodeId' in options) return startSellerSessions(options);
  const entries = await options.registry.list();
  const state: State = {
    options,
    allowed: new Set(options.buyerNodeIds.map((peer) => controlHex(peer))),
    known: new Set(entries.map((entry) => entry.buyerNodeId)),
    hosts: new Map(),
    closed: false,
  };
  try {
    // Recovery does not depend on continued pilot eligibility or the newly configured capacity.
    for (const entry of entries)
      if (!batchSessionTerminal(entry.stored))
        await host(state, entry.buyerNodeId);
  } catch (error) {
    await close(state);
    throw error;
  }
  return {
    service: {
      exchange: (request, peer, signal, onDelta, blocks, blockMode) =>
        run(state, peer, signal, async () => {
          await admission(state, request, peer);
          signal.throwIfAborted();
          const current = await host(state, peer);
          const reply = await current.service.exchange(
            request,
            peer,
            signal,
            onDelta,
            blocks,
            blockMode,
          );
          if (request.method === BATCH_METHODS.OPEN) state.known.add(peer);
          return reply;
        }),
      resumeBlock: (approval, peer, signal) =>
        run(state, peer, signal, async () => {
          if (!state.known.has(peer))
            return batchFail(SESSION_CODES.UNAVAILABLE);
          const current = await host(state, peer);
          if (!current.service.resumeBlock)
            return batchFail(SESSION_CODES.UNAVAILABLE);
          return current.service.resumeBlock(approval, peer, signal);
        }),
    },
    close: () => close(state),
  };
}
