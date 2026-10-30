// The seller's metered upto state machine: verify, write ahead, deposit once; later settle exactly
// one charge, write ahead, claim once, and repeat that same settlement on retries. Every failure is
// an UptoError with a static code; chain and store text never leaves.
import {
  UPTO_CHANNEL_STATES,
  UPTO_ERROR_CODES,
  type UptoErrorCode,
} from './constants';
import { UptoError } from './errors';
import { keyedLock } from './lock';
import type {
  UptoAdmission,
  UptoAuthorization,
  UptoChain,
  UptoChannelRecord,
  UptoSettlement,
  UptoStore,
  UptoTerms,
} from './types';

const ATOMIC = /^(0|[1-9][0-9]*)$/;
// The terms a seller declares itself; a request naming anything else is not for this seller.
const OWN_FIELDS = [
  'network',
  'asset',
  'payTo',
  'feePayer',
  'authorizer',
  'tokenProgram',
  'withdrawDelaySeconds',
] as const;

export interface UptoSellerOptions {
  chain: UptoChain;
  store: UptoStore;
  now: () => number;
  own: Pick<UptoTerms, (typeof OWN_FIELDS)[number]>;
}

function fail(code: UptoErrorCode): never {
  throw new UptoError(code);
}

async function attempt<T>(
  code: UptoErrorCode,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch {
    return fail(code);
  }
}

// Records the charge before claiming it, so a crash or failed claim can only ever retry that charge.
async function claimOnce(
  chain: UptoChain,
  write: (record: UptoChannelRecord) => Promise<void>,
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

export function createUptoSeller(options: UptoSellerOptions) {
  const { chain, store, now, own } = options;
  const locked = keyedLock();
  const write = (record: UptoChannelRecord) =>
    attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () => store.put(record));

  async function matches(
    authorization: UptoAuthorization,
    terms: UptoTerms,
  ): Promise<boolean> {
    return (
      OWN_FIELDS.every((field) => terms[field] === own[field]) &&
      authorization.maxAtomic === terms.maxAtomic &&
      (await chain.verify(authorization, terms).catch(() => false))
    );
  }

  async function admit(
    authorization: UptoAuthorization,
    terms: UptoTerms,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<UptoAdmission> {
    signal?.throwIfAborted();
    if (!(await matches(authorization, terms)))
      return fail(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH);
    return locked(authorization.channelId, async () => {
      if (
        await attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () =>
          store.get(authorization.channelId),
        )
      )
        return fail(UPTO_ERROR_CODES.CHANNEL_REUSED);
      if (now() >= terms.expiresAt) return fail(UPTO_ERROR_CODES.TERMS_EXPIRED);
      // Last point the caller can cancel: after this the deposit is broadcast and recorded.
      signal?.throwIfAborted();
      const admission = {
        channelId: authorization.channelId,
        payer: authorization.payer,
        maxAtomic: authorization.maxAtomic,
      };
      await write({ ...admission, state: UPTO_CHANNEL_STATES.DEPOSITING });
      await attempt(UPTO_ERROR_CODES.UNAVAILABLE, () =>
        chain.deposit(authorization, terms),
      );
      await write({ ...admission, state: UPTO_CHANNEL_STATES.ADMITTED });
      return admission;
    });
  }

  async function settle(
    channelId: string,
    chargedAtomic: string,
  ): Promise<UptoSettlement> {
    return locked(channelId, async () => {
      const record = await attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () =>
        store.get(channelId),
      );
      if (!record || record.state === UPTO_CHANNEL_STATES.DEPOSITING)
        return fail(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH);
      if (
        record.chargedAtomic !== undefined &&
        record.chargedAtomic !== chargedAtomic
      )
        return fail(UPTO_ERROR_CODES.ALREADY_SETTLED);
      if (record.settlement) return record.settlement;
      if (
        !ATOMIC.test(chargedAtomic) ||
        BigInt(chargedAtomic) > BigInt(record.maxAtomic)
      )
        return fail(UPTO_ERROR_CODES.CHARGE_EXCEEDS_CEILING);
      return claimOnce(chain, write, record, chargedAtomic);
    });
  }

  return {
    admit,
    settle,
    record: (channelId: string) =>
      attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () => store.get(channelId)),
  };
}
