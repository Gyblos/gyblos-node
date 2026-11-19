// Routes authenticated buyers to separate financial hosts while preserving one global foreground turn.
import {
  batchSessionTerminal,
  type BatchSellerRegistry,
} from '@gyblos/payments-upto/batch-session';
import { batchError, batchFail } from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import {
  startSellerSessions,
  type SellerSessionHost,
  type SellerSessionOptions,
} from './seller-sessions';

export type SellerSessionComposition =
  | Pick<SellerSessionOptions, 'buyerNodeId' | 'backend'>
  | { registry: BatchSellerRegistry };
type Common = Omit<SellerSessionOptions, 'buyerNodeId' | 'backend'>;
type Options = Common & SellerSessionComposition;
interface State {
  options: Common & {
    registry: BatchSellerRegistry;
  };
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
      admit: () => admit(state, peer),
      backend: state.options.registry.backend(peer),
    });
    state.hosts.set(peer, current);
  }
  return current;
}
async function admit(state: State, peer: string) {
  // The host calls this only after checking the signed quote. Timers can settle
  // channels while a buyer is offline; release those handles before admitting more.
  const retired = new Map<string, SellerSessionHost>();
  const allowed = await state.options.registry.permits(peer, (entries) => {
    const retained = new Set(entries.map((entry) => entry.buyerNodeId));
    for (const [buyer, current] of state.hosts) {
      if (buyer !== peer && !retained.has(buyer)) retired.set(buyer, current);
    }
  });
  for (const [buyer, current] of retired) {
    await current.close();
    state.hosts.delete(buyer);
  }
  if (!allowed) return batchFail(SESSION_CODES.BUSY);
}
async function run<T>(
  state: State,
  signal: AbortSignal,
  execute: () => Promise<T>,
) {
  if (state.closed) return batchFail(SESSION_CODES.UNAVAILABLE);
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
    hosts: new Map(),
    closed: false,
  };
  try {
    // Recovery does not depend on the newly configured capacity.
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
        run(state, signal, async () => {
          signal.throwIfAborted();
          const current = await host(state, peer);
          try {
            const reply = await current.service.exchange(
              request,
              peer,
              signal,
              onDelta,
              blocks,
              blockMode,
            );
            return reply;
          } finally {
            // An OPEN with a lost acknowledgement still owns its live recovery timer.
            if (!current.ownsSession?.()) {
              state.hosts.delete(peer);
              await current.close();
            }
          }
        }),
      resumeBlock: (approval, peer, signal) =>
        run(state, signal, async () => {
          if (
            !state.hosts.has(peer) &&
            !(await state.options.registry.backend(peer).inspect())?.recoverable
          )
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
