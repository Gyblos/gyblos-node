// The seller's metered upto state machine: verify, write ahead, deposit once; later settle exactly
// one charge, write ahead, claim once, and repeat that same settlement on retries. Every failure is
// an UptoError with a static code; chain and store text never leaves.
import { UPTO_CHANNEL_STATES, UPTO_ERROR_CODES } from './constants';
import { keyedLock } from './lock';
import {
  attempt,
  claimOnce,
  depositOnce,
  fail,
  recoverChannels,
  type SellerContext,
} from './seller-steps';
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

// The terms are this seller's own, carry an application memo, and the open verifies against them.
async function matches(
  { chain, own }: Pick<UptoSellerOptions, 'chain' | 'own'>,
  authorization: UptoAuthorization,
  terms: UptoTerms,
): Promise<boolean> {
  return (
    OWN_FIELDS.every((field) => terms[field] === own[field]) &&
    // An empty memo would turn off the payer's signature over the application binding.
    terms.memo.length > 0 &&
    authorization.maxAtomic === terms.maxAtomic &&
    (await chain.verify(authorization, terms).catch(() => false))
  );
}

export type UptoSeller = ReturnType<typeof createUptoSeller>;

export function createUptoSeller(options: UptoSellerOptions) {
  const { chain, store, now, own } = options;
  const locked = keyedLock();
  const write = (record: UptoChannelRecord) =>
    attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () => store.put(record));
  const context: SellerContext = { chain, store, locked, write };

  async function admit(
    authorization: UptoAuthorization,
    terms: UptoTerms,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<UptoAdmission> {
    signal?.throwIfAborted();
    if (!(await matches(options, authorization, terms)))
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
      await depositOnce(context, admission, () =>
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
      if (
        !record ||
        record.state === UPTO_CHANNEL_STATES.DEPOSITING ||
        record.state === UPTO_CHANNEL_STATES.FAILED
      )
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
      return claimOnce(context, record, chargedAtomic);
    });
  }

  return {
    admit,
    settle,
    recover: () => recoverChannels(context),
    record: (channelId: string) =>
      attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () => store.get(channelId)),
  };
}
