// Shared seller steps: static failures, write-ahead claim, deposit classification and crash
// recovery. Every chain or store failure becomes an UptoError with a static code.
import {
  UPTO_CHANNEL_STATES,
  UPTO_DEPOSIT_STATES,
  UPTO_ERROR_CODES,
  type UptoErrorCode,
} from './constants';
import { UptoError } from './errors';
import type { keyedLock } from './lock';
import type {
  UptoChain,
  UptoChannelRecord,
  UptoSettlement,
  UptoStore,
} from './types';

export interface SellerContext {
  chain: UptoChain;
  store: UptoStore;
  locked: ReturnType<typeof keyedLock>;
  write: (record: UptoChannelRecord) => Promise<void>;
}

export function fail(code: UptoErrorCode): never {
  throw new UptoError(code);
}

export async function attempt<T>(
  code: UptoErrorCode,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch {
    return fail(code);
  }
}

export // Records the charge before claiming it, so a crash or failed claim can only ever retry that charge;
// a claim the chain refuses for good lapses.
async function claimOnce(
  { chain, write }: SellerContext,
  record: UptoChannelRecord,
  chargedAtomic: string,
): Promise<UptoSettlement> {
  await write({
    ...record,
    state: UPTO_CHANNEL_STATES.SETTLING,
    chargedAtomic,
  });
  let transaction: string;
  try {
    ({ transaction } = await chain.claim(record, chargedAtomic));
  } catch (error) {
    if (
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.ALREADY_SETTLED
    )
      return fail(UPTO_ERROR_CODES.ALREADY_SETTLED);
    if (
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.FACILITATOR_REJECTED
    ) {
      await write({
        ...record,
        state: UPTO_CHANNEL_STATES.LAPSED,
        chargedAtomic,
      });
      return fail(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
    }
    return fail(UPTO_ERROR_CODES.UNAVAILABLE);
  }
  const settlement = {
    channelId: record.channelId,
    chargedAtomic,
    refundedAtomic: String(BigInt(record.maxAtomic) - BigInt(chargedAtomic)),
    transaction,
  };
  await write({
    ...record,
    state: UPTO_CHANNEL_STATES.SETTLED,
    chargedAtomic,
    settlement,
  });
  return settlement;
}

// A definitive refusal fails the channel at once; anything else stays DEPOSITING for recover().
export async function depositOnce(
  { write }: SellerContext,
  opened: Omit<UptoChannelRecord, 'state'>,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.ALREADY_SETTLED
    )
      return fail(UPTO_ERROR_CODES.ALREADY_SETTLED);
    if (
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.FACILITATOR_REJECTED
    ) {
      await write({ ...opened, state: UPTO_CHANNEL_STATES.FAILED });
      return fail(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
    }
    return fail(UPTO_ERROR_CODES.UNAVAILABLE);
  }
}

// Moves one record forward if it is still where the listing saw it; re-read under the channel lock
// so concurrent admission, settlement or recovery is never overwritten with a stale copy.
async function recoverOne(
  context: SellerContext,
  channelId: string,
): Promise<UptoChannelRecord | undefined> {
  const { chain, store, write } = context;
  const record = await store.get(channelId);
  if (record?.state === UPTO_CHANNEL_STATES.DEPOSITING) {
    const deposit = await chain.depositState(channelId);
    if (deposit === UPTO_DEPOSIT_STATES.PENDING) return undefined;
    const next = {
      ...record,
      state:
        deposit === UPTO_DEPOSIT_STATES.LANDED
          ? UPTO_CHANNEL_STATES.ADMITTED
          : UPTO_CHANNEL_STATES.FAILED,
    };
    await write(next);
    return next;
  }
  if (
    record?.state === UPTO_CHANNEL_STATES.SETTLING &&
    record.chargedAtomic !== undefined
  ) {
    const settlement = await claimOnce(context, record, record.chargedAtomic);
    return { ...record, state: UPTO_CHANNEL_STATES.SETTLED, settlement };
  }
  return undefined;
}

// Resolves records left between a chain call and its store write: a deposit becomes ADMITTED or
// FAILED by what the chain shows (or waits while it may still land), and a settlement in progress
// is claimed again with its own recorded charge (claims are idempotent). A record that cannot move
// yet never stops the others. Returns the records it changed.
export async function recoverChannels(
  context: SellerContext,
): Promise<UptoChannelRecord[]> {
  const listed = await attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () =>
    context.store.list(),
  );
  const changed: UptoChannelRecord[] = [];
  for (const { channelId } of listed) {
    try {
      const next = await context.locked(channelId, () =>
        recoverOne(context, channelId),
      );
      if (next) changed.push(next);
    } catch {
      // Left as it is; the next recovery tries again.
    }
  }
  return changed;
}
