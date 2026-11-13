// Shared deposit authority counts spent plus still-committed funds; only proved refunds return credit.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import { controlAtomic, controlHex } from '@gyblos/protocol/control-validation';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

import {
  openPoolStore,
  poolChild,
  poolPaths,
  readPool,
} from './batch-pool-store';
import type {
  BatchBuyerPool,
  BatchPoolOptions,
  PoolRow,
} from './batch-pool-types';
import { termsFor } from './batch-session-checks';
import { inspectBatchSession, storedBatchSession } from './batch-session-state';
import { serial } from './batch-session-store';

function budget(entries: PoolRow[], total: string) {
  const committed = entries.reduce(
    (sum, entry) =>
      sum + BigInt(entry.terms.depositAtomic) - BigInt(entry.refundedAtomic),
    0n,
  );
  return {
    committedAtomic: String(committed),
    availableAtomic: String(
      committed >= BigInt(total) ? 0n : BigInt(total) - committed,
    ),
  };
}
export async function inspectBatchPool(
  paths: BatchPoolOptions['paths'],
  options: { includeLegacy?: boolean } = {},
) {
  const entries = (await readPool(paths, options.includeLegacy ?? true))
    .entries;
  return Promise.all(
    entries.map(async (row) => {
      if (!row.ready) return { ...row, stored: undefined };
      const stored = storedBatchSession(await poolChild(paths, row));
      return { ...row, stored };
    }),
  );
}
interface PoolContext {
  options: BatchPoolOptions;
  total: string;
  store: Awaited<ReturnType<typeof openPoolStore>>;
  rowFor(id: string): PoolRow;
}
async function allocate(context: PoolContext, terms: PaymentSessionTerms) {
  const { options, store, total, rowFor } = context;
  const checked = termsFor(terms);
  let row = store
    .read()
    .entries.find((entry) => entry.terms.sellerNodeId === checked.sellerNodeId);
  if (row && canonicalJson(row.terms) !== canonicalJson(checked))
    return sessionFail(SESSION_CODES.BINDING);
  if (!row) {
    const first = store.read().entries[0]?.terms;
    if (
      first &&
      (first.buyer !== checked.buyer ||
        first.buyerNodeId !== checked.buyerNodeId ||
        first.network !== checked.network ||
        first.mint !== checked.mint)
    )
      return sessionFail(SESSION_CODES.BINDING);
    if (
      store.read().entries.length >= BATCH_SESSION_DEFAULTS.maxSessions ||
      BigInt(budget(store.read().entries, total).availableAtomic) <
        BigInt(checked.depositAtomic)
    )
      return sessionFail(SESSION_CODES.LIMIT);
    row = {
      terms: checked,
      legacy: false,
      ready: false,
      uncertain: false,
      requestId: null,
      refundedAtomic: '0',
    };
    const added = row;
    await store.update((next) => {
      next.entries.push(added);
    });
  }
  await store.prepare(row);
  const stored = await inspectBatchSession(poolPaths(options.paths, row));
  if (!stored) return sessionFail(SESSION_CODES.UNVERIFIED);
  return { ...rowFor(checked.sellerNodeId), stored };
}

async function resolve(
  context: PoolContext,
  id: string,
  unsentRequestId?: string,
) {
  const { options, store, rowFor } = context;
  const row = rowFor(id);
  const record = await poolChild(options.paths, row);
  const closed =
    record.state === SESSION_STATES.CLOSED && record.settlement !== null;
  const accepted =
    row.requestId !== null && record.requests[row.requestId]?.accepted === true;
  const pristine =
    record.hints === null &&
    record.opening === null &&
    Object.keys(record.requests).length === 0;
  const unsent =
    unsentRequestId === row.requestId &&
    unsentRequestId !== undefined &&
    !Object.hasOwn(record.requests, unsentRequestId) &&
    Object.keys(record.pending).length === 0 &&
    (pristine ||
      (record.state === SESSION_STATES.OPEN &&
        Object.values(record.requests).every((request) => request.accepted)));
  if (
    !closed &&
    !unsent &&
    (row.uncertain || row.requestId !== null) &&
    !accepted &&
    !pristine
  )
    return false;
  if (
    row.requestId === null &&
    !row.uncertain &&
    (!closed || row.refundedAtomic === record.settlement!.refundedAtomic)
  )
    return true;
  await store.update((next) => {
    const current = next.entries.find(
      (entry) => entry.terms.sellerNodeId === id,
    )!;
    current.requestId = null;
    current.uncertain = false;
    if (closed) current.refundedAtomic = record.settlement!.refundedAtomic;
  });
  return true;
}
export async function openBatchBuyerPool(
  options: BatchPoolOptions,
): Promise<BatchBuyerPool> {
  const total = controlAtomic(options.totalDepositAtomic);
  if (total === '0') return sessionFail();
  const store = await openPoolStore(options.paths, options.now);
  const exclusive = serial();
  const backends = new Map<string, ReturnType<BatchPoolOptions['backend']>>();
  const rowFor = (id: string) => {
    const row = store
      .read()
      .entries.find((entry) => entry.terms.sellerNodeId === controlHex(id));
    if (!row) return sessionFail(SESSION_CODES.BINDING);
    return row;
  };
  const context: PoolContext = { options, total, store, rowFor };
  return {
    list: () =>
      exclusive(async () => {
        const rows = store.read().entries;
        return Promise.all(
          rows.map(async (row) => {
            const stored = storedBatchSession(
              await poolChild(options.paths, row),
            );
            return { ...row, stored };
          }),
        );
      }),
    allocate: (terms) => exclusive(() => allocate(context, terms)),
    begin: (id, requestId) =>
      exclusive(async () => {
        const row = rowFor(id);
        const record = await poolChild(options.paths, row);
        if (row.requestId !== null || Object.hasOwn(record.requests, requestId))
          return sessionFail(SESSION_CODES.UNVERIFIED);
        await store.update((next) => {
          const row = next.entries.find(
            (entry) => entry.terms.sellerNodeId === id,
          )!;
          row.requestId = controlHex(requestId, PAYMENT_SESSION.requestIdBytes);
          row.uncertain = true;
        });
      }),
    resolve: (id, unsentRequestId) =>
      exclusive(() => resolve(context, id, unsentRequestId)),
    backend: (id) =>
      exclusive(async () => {
        const row = rowFor(id);
        await poolChild(options.paths, row);
        let pending = backends.get(id);
        if (!pending) {
          pending = options.backend(poolPaths(options.paths, row));
          backends.set(id, pending);
          const current = pending;
          void current.catch(() => {
            if (backends.get(id) === current) backends.delete(id);
          });
        }
        return pending;
      }),
    budget: () => exclusive(async () => budget(store.read().entries, total)),
    dispose: () => exclusive(store.dispose),
  };
}
