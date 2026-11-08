// The seller's metered upto state machine: verify, write ahead, deposit once; later settle exactly
// one charge, write ahead, claim once, and repeat that same settlement on retries. Every failure is
// an UptoError with a static code; chain and store text never leaves.
import { uptoClaimUntil } from './authorization';
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

interface AdmissionOptions {
  signal?: AbortSignal;
  minClaimWindowMs?: number;
}

// The verified payload deadline and quote expiry must still hold after awaited admission work.
function expiryCheck(
  authorization: UptoAuthorization,
  terms: UptoTerms,
  now: () => number,
  minimum: number | undefined,
) {
  const reserve = minimum ?? 0;
  if (!Number.isSafeInteger(reserve) || reserve < 0)
    return fail(UPTO_ERROR_CODES.INVALID_TERMS);
  const cutoff =
    minimum === undefined ? undefined : uptoClaimUntil(authorization);
  return () =>
    now() >= terms.expiresAt ||
    (cutoff !== undefined && cutoff - now() <= reserve);
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
    { signal, minClaimWindowMs }: AdmissionOptions = {},
  ): Promise<UptoAdmission> {
    signal?.throwIfAborted();
    if (!(await matches(options, authorization, terms)))
      return fail(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH);
    const expired = expiryCheck(authorization, terms, now, minClaimWindowMs);
    return locked(authorization.channelId, async () => {
      if (
        await attempt(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE, () =>
          store.get(authorization.channelId),
        )
      )
        return fail(UPTO_ERROR_CODES.CHANNEL_REUSED);
      if (expired()) return fail(UPTO_ERROR_CODES.TERMS_EXPIRED);
      // Last point the caller can cancel: after this the deposit is broadcast and recorded.
      signal?.throwIfAborted();
      const admission = {
        channelId: authorization.channelId,
        payer: authorization.payer,
        maxAtomic: authorization.maxAtomic,
      };
      const opened = { ...admission, payload: authorization.payload, terms };
      await write({ ...opened, state: UPTO_CHANNEL_STATES.DEPOSITING });
      // Persistence may consume the reserve. This refusal is definitive: no deposit was requested.
      if (expired()) {
        await write({ ...opened, state: UPTO_CHANNEL_STATES.FAILED });
        return fail(UPTO_ERROR_CODES.TERMS_EXPIRED);
      }
      await depositOnce(context, opened, () =>
        chain.deposit(authorization, terms),
      );
      await write({ ...opened, state: UPTO_CHANNEL_STATES.ADMITTED });
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
      if (record.state === UPTO_CHANNEL_STATES.LAPSED)
        return fail(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
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
