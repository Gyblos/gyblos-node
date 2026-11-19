// Owns bounded durable seller admission; each authenticated buyer retains its own financial journal.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  batchSellerBuyerPaths,
  type BatchSellerPaths,
} from '@gyblos/config/home';
import { controlHex } from '@gyblos/protocol/control-validation';
import {
  PaymentSessionError,
  SESSION_CODES,
  sessionFail,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

import {
  openSellerRegistryStore,
  sellerRegistryPaths,
} from './batch-seller-store';
import { openBatchSellerBackend } from './batch-session-backend';
import {
  batchSessionTerminal,
  type BatchStoredSession,
} from './batch-session-state';
import { serial } from './batch-session-store';
import type { BatchSellerBackend } from './batch-session-types';
import { BATCH_SELLER_REGISTRY } from './constants';

export interface BatchSellerRegistryEntry {
  buyerNodeId: string;
  stored: BatchStoredSession;
}
export interface BatchSellerRegistry {
  list(): Promise<BatchSellerRegistryEntry[]>;
  permits(buyerNodeId: string): Promise<boolean>;
  backend(buyerNodeId: string): BatchSellerBackend;
  // Financial handles are owned and disposed by the host; this drains admission and releases its lock.
  dispose(): Promise<void>;
}
interface Options extends Omit<
  Parameters<typeof openBatchSellerBackend>[0],
  'paths'
> {
  paths: BatchSellerPaths;
  maxSessions: number;
}
interface State {
  options: Options;
  store: Awaited<ReturnType<typeof openSellerRegistryStore>>;
  exclusive: ReturnType<typeof serial>;
  closing: boolean;
}
async function rows(state: State): Promise<BatchSellerRegistryEntry[]> {
  const entries = [];
  const archived = new Set<string>();
  for (const row of state.store.read().entries) {
    if (row.prepared !== null) return sessionFail(SESSION_CODES.UNAVAILABLE);
    const backend = openBatchSellerBackend({
      ...state.options,
      paths: sellerRegistryPaths(state.options.paths, row),
    });
    const stored = await backend.inspect();
    if (!stored || stored.terms.buyerNodeId !== row.buyerNodeId)
      return sessionFail(SESSION_CODES.UNVERIFIED);
    if (stored.archivedProof) archived.add(row.buyerNodeId);
    else entries.push({ buyerNodeId: row.buyerNodeId, stored });
  }
  // Archive in place: remove only the index reference, never move or rewrite financial evidence.
  if (archived.size)
    await state.store.update((record) => {
      record.entries = record.entries.filter(
        (row) => !archived.has(row.buyerNodeId),
      );
    });
  return entries;
}
async function permits(state: State, peer: string) {
  const entries = await rows(state);
  if (
    entries.some(
      (row) => row.buyerNodeId === peer && !batchSessionTerminal(row.stored),
    )
  )
    return true;
  return (
    entries.filter((row) => !batchSessionTerminal(row.stored)).length <
    state.options.maxSessions
  );
}
function run<T>(state: State, operation: () => Promise<T>): Promise<T> {
  return state.exclusive(() => {
    if (state.closing) return sessionFail(SESSION_CODES.UNAVAILABLE);
    return operation();
  });
}
async function create(
  state: State,
  peer: string,
  base: BatchSellerBackend,
  terms: PaymentSessionTerms,
  payload?: string,
) {
  if (terms.buyerNodeId !== peer) return sessionFail(SESSION_CODES.BINDING);
  const found = state.store
    .read()
    .entries.find((row) => row.buyerNodeId === peer);
  if (found) {
    if (found.prepared !== null) return sessionFail(SESSION_CODES.UNAVAILABLE);
    return base.create(terms, payload);
  }
  const old = await base.inspect();
  if (old?.archivedProof) return base.create(terms, payload);
  if (!(await permits(state, peer))) return sessionFail(SESSION_CODES.BUSY);
  if (state.store.read().entries.length >= BATCH_SELLER_REGISTRY.maxBuyers)
    return sessionFail(SESSION_CODES.LIMIT);
  if (old) return sessionFail(SESSION_CODES.UNVERIFIED);
  // The backend verifies the signed native opening before a new row is published; create never submits.
  const financial = await base.create(terms, payload);
  try {
    if (state.closing) return sessionFail(SESSION_CODES.UNAVAILABLE);
    const row = { buyerNodeId: peer, legacy: false, prepared: terms };
    await state.store.update((record) => {
      record.entries.push(row);
    });
    await state.store.prepare(row);
    if (state.closing) return sessionFail(SESSION_CODES.UNAVAILABLE);
    return financial;
  } catch (error) {
    await financial.dispose();
    throw error;
  }
}
function backend(state: State, peer: string): BatchSellerBackend {
  const buyerNodeId = controlHex(peer);
  const found = state.store
    .read()
    .entries.find((row) => row.buyerNodeId === buyerNodeId);
  const paths = found
    ? sellerRegistryPaths(state.options.paths, found)
    : state.store.legacyPeer === buyerNodeId
      ? state.options.paths.legacy
      : batchSellerBuyerPaths(state.options.paths, buyerNodeId);
  const base = openBatchSellerBackend({ ...state.options, paths });
  return {
    inspect: () =>
      run(state, async () => {
        const stored = await base.inspect();
        const known = state.store
          .read()
          .entries.some((row) => row.buyerNodeId === buyerNodeId);
        if (
          stored &&
          ((!known && !stored.archivedProof) ||
            stored.terms.buyerNodeId !== buyerNodeId)
        )
          return sessionFail(SESSION_CODES.UNVERIFIED);
        if (known && !stored) return sessionFail(SESSION_CODES.UNVERIFIED);
        return stored;
      }),
    create: (terms, payload) =>
      run(state, () => create(state, buyerNodeId, base, terms, payload)),
    renew: (expected, terms, payload) =>
      run(state, async () => {
        if (terms.buyerNodeId !== buyerNodeId)
          return sessionFail(SESSION_CODES.BINDING);
        if (!(await permits(state, buyerNodeId)))
          return sessionFail(SESSION_CODES.BUSY);
        if (
          !state.store
            .read()
            .entries.some((row) => row.buyerNodeId === buyerNodeId)
        ) {
          if (!(await base.inspect())?.archivedProof)
            return sessionFail(SESSION_CODES.UNVERIFIED);
          if (
            state.store.read().entries.length >= BATCH_SELLER_REGISTRY.maxBuyers
          )
            return sessionFail(SESSION_CODES.LIMIT);
          await state.store.update((record) => {
            record.entries.push({
              buyerNodeId,
              legacy: state.store.legacyPeer === buyerNodeId,
              prepared: null,
            });
          });
        }
        if (!base.renew) return sessionFail(SESSION_CODES.UNAVAILABLE);
        await base.renew(expected, terms, payload);
      }),
  };
}
export async function openBatchSellerRegistry(
  options: Options,
): Promise<BatchSellerRegistry> {
  if (
    !Number.isSafeInteger(options.maxSessions) ||
    options.maxSessions < 1 ||
    options.maxSessions > BATCH_SESSION_DEFAULTS.maxSessions
  )
    return sessionFail(SESSION_CODES.LIMIT);
  const store = await openSellerRegistryStore(
    options.paths,
    options.now ?? Date.now,
  ).catch((error: unknown) => {
    if (error instanceof PaymentSessionError) throw error;
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  });
  const state: State = { options, store, exclusive: serial(), closing: false };
  let disposing: Promise<void> | undefined;
  return {
    list: () => run(state, () => rows(state)),
    permits: (peer) => run(state, () => permits(state, controlHex(peer))),
    backend: (peer) => backend(state, peer),
    dispose() {
      state.closing = true;
      return (disposing ??= state.exclusive(() => store.dispose()));
    },
  };
}
