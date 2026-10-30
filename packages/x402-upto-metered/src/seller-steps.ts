// Shared seller steps: static failures, write-ahead claim, deposit classification and crash
// recovery. Every chain or store failure becomes an UptoError with a static code.
import {
  UPTO_CHANNEL_STATES,
  UPTO_ERROR_CODES,
  type UptoErrorCode,
} from './constants';
import { UptoError } from './errors';
import type { keyedLock } from './lock';
import type {
  UptoAdmission,
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

export // Records the charge before claiming it, so a crash or failed claim can only ever retry that charge.
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
  const { transaction } = await attempt(UPTO_ERROR_CODES.UNAVAILABLE, () =>
    chain.claim(record, chargedAtomic),
  );
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
  admission: UptoAdmission,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.FACILITATOR_REJECTED
    ) {
      await write({ ...admission, state: UPTO_CHANNEL_STATES.FAILED });
      return fail(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
    }
    return fail(UPTO_ERROR_CODES.UNAVAILABLE);
  }
}

// Resolves records left between a chain call and its store write: a deposit becomes ADMITTED or
// FAILED by what the chain shows, and a settlement in progress is claimed again with its own
// recorded charge (claims are idempotent). Returns the records it changed.
export async function recoverChannels(
  context: SellerContext,
): Promise<UptoChannelRecord[]> {
  const { chain, store, locked, write } = context;
  const records = await attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () =>
    store.list(),
  );
  const changed: UptoChannelRecord[] = [];
  for (const record of records)
    await locked(record.channelId, async () => {
      if (record.state === UPTO_CHANNEL_STATES.DEPOSITING) {
        const open = await attempt(UPTO_ERROR_CODES.UNAVAILABLE, () =>
          chain.channelOpen(record.channelId),
        );
        const next = {
          ...record,
          state: open
            ? UPTO_CHANNEL_STATES.ADMITTED
            : UPTO_CHANNEL_STATES.FAILED,
        };
        await write(next);
        changed.push(next);
      } else if (
        record.state === UPTO_CHANNEL_STATES.SETTLING &&
        record.chargedAtomic !== undefined
      ) {
        const settlement = await claimOnce(
          context,
          record,
          record.chargedAtomic,
        );
        changed.push({
          ...record,
          state: UPTO_CHANNEL_STATES.SETTLED,
          settlement,
        });
      }
    });
  return changed;
}
