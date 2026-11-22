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

import { batchOpeningAbsent, replaceableOpening } from './batch-opening-proof';
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
import { sameBatchParties } from './batch-session-history';
import { inspectBatchSession, storedBatchSession } from './batch-session-state';
import { serial } from './batch-session-store';
import { BATCH_BUYER_CHECKPOINTS } from './constants';

function budget(
  entries: PoolRow[],
  total: string,
  unfunded: ReadonlySet<string>,
) {
  const committed = entries.reduce(
    (sum, entry) =>
      sum +
      BigInt(entry.terms.depositAtomic) -
      (unfunded.has(entry.terms.sellerNodeId)
        ? BigInt(entry.terms.depositAtomic)
        : BigInt(entry.refundedAtomic)),
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
export async function poolAllowsSellerDeposit(
  paths: BatchPoolOptions['paths'],
  sellerNodeId: string,
  total: string,
  deposit: string,
) {
  const entries = await inspectBatchPool(paths);
  if (
    entries.some(
      (row) =>
        !row.ready ||
        row.uncertain ||
        row.requestId !== null ||
        row.stored?.pending ||
        row.stored?.recoverable,
    )
  )
    return false;
  const unfunded = new Set(
    entries
      .filter((row) => row.stored?.notCreated)
      .map((row) => row.terms.sellerNodeId),
  );
  const funds = budget(entries, total, unfunded);
  if (BigInt(funds.committedAtomic) > BigInt(total)) return false;
  const existing = entries.find(
    (row) => row.terms.sellerNodeId === sellerNodeId,
  );
  if (
    existing &&
    !existing.stored?.notCreated &&
    !existing.stored?.openingReturned
  )
    return existing.stored?.empty === true;
  return BigInt(funds.availableAtomic) >= BigInt(deposit);
}
interface PoolContext {
  options: BatchPoolOptions;
  total: string;
  unfunded: Set<string>;
  store: Awaited<ReturnType<typeof openPoolStore>>;
  rowFor(id: string): PoolRow;
}
async function replacePoolEntry(
  context: PoolContext,
  row: PoolRow,
  checked: PaymentSessionTerms,
) {
  const { options, store, total, rowFor } = context;
  const old = await poolChild(options.paths, row);
  if (row.requestId || row.uncertain || !replaceableOpening(old))
    return sessionFail(SESSION_CODES.BINDING);
  if (
    BigInt(
      budget(store.read().entries, total, context.unfunded).availableAtomic,
    ) < BigInt(checked.depositAtomic)
  )
    return sessionFail(SESSION_CODES.LIMIT);
  if (
    !sameBatchParties(row.terms, checked) ||
    checked.expiresAt <= row.terms.expiresAt
  )
    return sessionFail(SESSION_CODES.BINDING);
  await store.update((next) => {
    const replacing = next.entries.find(
      (entry) => entry.terms.sellerNodeId === checked.sellerNodeId,
    )!;
    replacing.terms = checked;
    replacing.ready = false;
    replacing.replacing = old.channelId;
    replacing.refundedAtomic = '0';
  });
  context.unfunded.delete(checked.sellerNodeId);
  row = rowFor(checked.sellerNodeId);
  try {
    const backend = await options.backend(poolPaths(options.paths, row));
    if (!backend.renew) return sessionFail(SESSION_CODES.UNAVAILABLE);
    await backend.renew(old.channelId, checked, checked.depositAtomic);
  } finally {
    await store.prepare(row);
    if (
      batchOpeningAbsent(
        await poolChild(options.paths, rowFor(checked.sellerNodeId)),
      )
    )
      context.unfunded.add(checked.sellerNodeId);
  }
  return rowFor(checked.sellerNodeId);
}
async function allocate(context: PoolContext, terms: PaymentSessionTerms) {
  const { options, store, total, rowFor } = context;
  const checked = termsFor(terms);
  let row = store
    .read()
    .entries.find((entry) => entry.terms.sellerNodeId === checked.sellerNodeId);
  if (row && canonicalJson(row.terms) !== canonicalJson(checked)) {
    row = await replacePoolEntry(context, row, checked);
  }
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
      BigInt(
        budget(store.read().entries, total, context.unfunded).availableAtomic,
      ) < BigInt(checked.depositAtomic)
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
  const notCreated = batchOpeningAbsent(record) !== undefined;
  const closed =
    record.state === SESSION_STATES.CLOSED && record.settlement !== null;
  const accepted =
    row.requestId !== null && record.requests[row.requestId]?.accepted === true;
  const pristine =
    record.hints === null &&
    record.opening === null &&
    Object.keys(record.requests).length === 0;
  // The marker precedes begin(), which persists this request before any prompt write.
  const checking =
    unsentRequestId ??
    (record.pending[BATCH_BUYER_CHECKPOINTS.OPENING_SENT] === record.channelId
      ? row.requestId
      : undefined);
  const declined =
    row.requestId !== null &&
    record.pending[BATCH_BUYER_CHECKPOINTS.DECLINED_REQUEST] ===
      row.requestId &&
    !Object.hasOwn(record.requests, row.requestId);
  const unsent =
    checking === row.requestId &&
    typeof checking === 'string' &&
    !Object.hasOwn(record.requests, checking) &&
    Object.keys(record.pending).every(
      (key) =>
        key === BATCH_BUYER_CHECKPOINTS.OPENING_SENT ||
        (unsentRequestId !== undefined &&
          key === BATCH_BUYER_CHECKPOINTS.DECLINED_REQUEST &&
          record.pending[key] !== unsentRequestId),
    ) &&
    (pristine ||
      (record.state === SESSION_STATES.OPEN &&
        Object.values(record.requests).every((request) => request.accepted)));
  if (
    !closed &&
    !notCreated &&
    !declined &&
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
  ) {
    if (notCreated) context.unfunded.add(id);
    return true;
  }
  await store.update((next) => {
    const current = next.entries.find(
      (entry) => entry.terms.sellerNodeId === id,
    )!;
    current.requestId = null;
    current.uncertain = false;
    if (closed) current.refundedAtomic = record.settlement!.refundedAtomic;
  });
  if (notCreated) context.unfunded.add(id);
  return true;
}
async function unfundedRows(
  paths: BatchPoolOptions['paths'],
  store: PoolContext['store'],
) {
  const unfunded = new Set<string>();
  try {
    for (const row of store.read().entries)
      if (batchOpeningAbsent(await poolChild(paths, row)))
        unfunded.add(row.terms.sellerNodeId);
  } catch (error) {
    await store.dispose();
    throw error;
  }
  return unfunded;
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
  const unfunded = await unfundedRows(options.paths, store);
  const context: PoolContext = { options, total, store, rowFor, unfunded };
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
        if (batchOpeningAbsent(record))
          return sessionFail(SESSION_CODES.CLOSED);
        if (
          row.requestId !== null ||
          record.pending[BATCH_BUYER_CHECKPOINTS.DECLINED_REQUEST] ===
            requestId ||
          Object.hasOwn(record.requests, requestId)
        )
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
    budget: () =>
      exclusive(async () =>
        budget(store.read().entries, total, context.unfunded),
      ),
    dispose: () => exclusive(store.dispose),
  };
}
