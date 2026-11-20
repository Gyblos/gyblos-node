// Rotates only a definitively closed financial generation under the existing private journal lock.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import { controlAtomic } from '@gyblos/protocol/control-validation';
import {
  PAYMENT_SESSION,
  PaymentSessionError,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type PaymentSessionTerms,
  type SessionSettlement,
} from '@gyblos/protocol/payment-session';
import {
  acquireProcessLock,
  ensurePrivatePaymentPaths,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { parseRecord, termsFor } from './batch-session-checks';
import { initialRecord } from './batch-session-common';
import { sameBatchParties } from './batch-session-history';
import { withBatchState } from './batch-session-io';
import { priorBatchSpent, readBatchRecord } from './batch-session-state';
import type {
  BatchGeneration,
  BatchPaths,
  BatchRecord,
} from './batch-session-types';
import { BATCH_BLOCK_STATE, BATCH_RENEWAL_STATE } from './constants';

export interface BatchRenewalOptions {
  paths: BatchPaths;
  expectedChannelId: string;
  terms: PaymentSessionTerms;
  now: () => number;
  observe(channelId: string): Promise<SessionSettlement | undefined>;
  totalBudgetAtomic?: string;
}

export async function renewBatchSession(
  options: BatchRenewalOptions,
): Promise<void> {
  const terms = termsFor(options.terms);
  await ensurePrivatePaymentPaths(options.paths);
  const lock = await acquireProcessLock(options.paths.lock);
  try {
    const previous = await readBatchRecord(options.paths);
    if (!previous) return sessionFail(SESSION_CODES.UNAVAILABLE);
    const unsigned = unsignedPreparation(previous);
    const same = canonicalJson(previous.terms) === canonicalJson(terms);
    const retried =
      same &&
      (previous.history?.at(-1)?.channelId === options.expectedChannelId ||
        (unsigned && options.expectedChannelId === ''));
    if (retried) {
      checkBudget(
        priorBatchSpent(previous),
        terms.depositAtomic,
        options.totalBudgetAtomic,
      );
      return;
    }
    if (
      previous.channelId !== options.expectedChannelId ||
      !sameBatchParties(previous.terms, terms)
    )
      return sessionFail(SESSION_CODES.BINDING);
    if (
      !unsigned &&
      (previous.state !== SESSION_STATES.CLOSED || !previous.settlement)
    )
      return sessionFail(SESSION_CODES.UNVERIFIED);
    if (
      terms.expiresAt <= previous.terms.expiresAt ||
      terms.expiresAt <= options.now() ||
      (!unsigned &&
        (previous.history?.length ?? 0) >= BATCH_RENEWAL_STATE.maxHistory)
    )
      return sessionFail(SESSION_CODES.LIMIT);
    const observed = unsigned
      ? undefined
      : await options.observe(previous.channelId);
    if (
      !unsigned &&
      (!observed ||
        canonicalJson(observed) !== canonicalJson(previous.settlement))
    )
      return sessionFail(SESSION_CODES.UNVERIFIED);
    checkBudget(
      priorBatchSpent(previous) + BigInt(observed?.chargedAtomic ?? '0'),
      terms.depositAtomic,
      options.totalBudgetAtomic,
    );
    const serialized = preparedGeneration(
      previous,
      terms,
      options.now(),
      unsigned,
    );
    await lock.verify();
    await withBatchState(options.paths, () =>
      writePrivateFile(
        options.paths.state,
        serialized,
        BATCH_SESSION_DEFAULTS.stateBytes,
      ),
    );
  } catch (error) {
    if (error instanceof PaymentSessionError) throw error;
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  } finally {
    await lock.release();
  }
}

function checkBudget(
  spent: bigint,
  deposit: string,
  ceiling: string | undefined,
) {
  if (
    ceiling !== undefined &&
    spent + BigInt(deposit) > BigInt(controlAtomic(ceiling))
  )
    return sessionFail(SESSION_CODES.LIMIT);
}

function preparedGeneration(
  previous: BatchRecord,
  terms: PaymentSessionTerms,
  now: number,
  unsigned: boolean,
) {
  const { history, ...current } = previous;
  const archived: BatchGeneration = {
    ...current,
    version: current.blocks
      ? BATCH_BLOCK_STATE.version
      : PAYMENT_SESSION.version,
  };
  const next = parseRecord(
    unsigned
      ? { ...previous, terms, lastActivity: now }
      : {
          ...initialRecord(terms, now),
          version: BATCH_RENEWAL_STATE.version,
          history: [...(history ?? []), archived],
        },
    terms,
  );
  const serialized = JSON.stringify(next);
  if (Buffer.byteLength(serialized) > BATCH_SESSION_DEFAULTS.stateBytes)
    return sessionFail(SESSION_CODES.LIMIT);
  return serialized;
}

function unsignedPreparation(record: BatchRecord) {
  return (
    record.state === SESSION_STATES.OPENING &&
    record.channelId === '' &&
    record.hints === null &&
    record.salt === '0' &&
    record.opening === null &&
    record.voucher === null &&
    record.cumulativeAtomic === '0' &&
    Object.keys(record.requests).length === 0 &&
    Object.keys(record.pending).length === 0 &&
    record.closing === null &&
    record.settlement === null &&
    record.blocks === undefined
  );
}
