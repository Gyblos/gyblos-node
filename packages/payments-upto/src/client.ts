// The buyer's PaymentClient over x402-upto-metered: trusts only terms within its own policy (never the
// seller's fee or treasury), journals each request before signing its one channel open, and accepts a
// receipt only when the chain shows that settlement for its own metering.
import { isAddress, type TransactionSigner } from '@solana/kit';
import {
  createUptoAuthorization,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoClientHints,
} from 'x402-upto-metered';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentSettlement,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import type { UptoBuyerJournal } from './buyer-journal';
import { uptoTermsFor, type UptoChannelSettings } from './terms';

// What this buyer accepts: its network and asset, the network's fee and treasury, and the most it
// deposits for one request.
export interface UptoBuyerPolicy {
  network: string;
  mint: string;
  protocolFeeBps: number;
  treasury: string;
  maxAtomic: string;
}

// What the chain shows for a settlement transaction on this channel, or undefined when it shows none.
export type UptoSettlementView = (
  settlement: PaymentSettlement,
  channel: { channelId: string; maxAtomic: string },
) => Promise<Omit<PaymentSettlement, 'transaction'> | undefined>;

export interface UptoPaymentClientOptions {
  payer: TransactionSigner;
  policy: UptoBuyerPolicy;
  settings: UptoChannelSettings;
  hints: () => Promise<UptoClientHints>;
  journal: UptoBuyerJournal;
  confirm: UptoSettlementView;
  now: () => number;
}

// Atomic amounts are u64, so at most 20 digits.
const ATOMIC = /^(0|[1-9][0-9]{0,19})$/;
const DIGEST = /^[0-9a-f]{64}$/;

function fail(code: PaymentErrorCode): never {
  throw new PaymentError(code);
}

function trusted(
  terms: PaymentTerms,
  policy: UptoBuyerPolicy,
  payer: string,
  now: number,
): boolean {
  return (
    terms.network === policy.network &&
    terms.mint === policy.mint &&
    [terms.payTo, terms.feePayer, terms.authorizer].every(isAddress) &&
    // The fee payer signs and pays the open; the buyer must never be it.
    terms.feePayer !== payer &&
    terms.protocolFeeBps === policy.protocolFeeBps &&
    terms.treasury === policy.treasury &&
    terms.buyer === payer &&
    ATOMIC.test(terms.maxAtomic) &&
    BigInt(terms.maxAtomic) > 0n &&
    BigInt(terms.maxAtomic) <= BigInt(policy.maxAtomic) &&
    DIGEST.test(terms.requestDigest) &&
    Number.isSafeInteger(terms.expiresAt) &&
    terms.expiresAt > now
  );
}

// Hints failures: another network is untrusted, anything else is unavailable.
async function hintsFor(options: UptoPaymentClientOptions) {
  try {
    return await options.hints();
  } catch (error) {
    if (
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.INVALID_TERMS
    )
      return fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
    return fail(PAYMENT_ERROR_CODES.UNAVAILABLE);
  }
}

async function journaled(run: () => Promise<void>) {
  try {
    await run();
  } catch {
    fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
  }
}

// The channel terms the buyer will sign, or a refusal: built before anything is journaled.
async function channelTerms(
  options: UptoPaymentClientOptions,
  terms: PaymentTerms,
) {
  try {
    return await uptoTermsFor(terms, options.settings);
  } catch {
    return fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  }
}

async function signOpen(
  options: UptoPaymentClientOptions,
  terms: PaymentTerms,
): Promise<PaymentAuthorization> {
  const channel = await channelTerms(options, terms);
  const hints = await hintsFor(options);
  const entry = {
    requestDigest: terms.requestDigest,
    channelId: null,
    maxAtomic: terms.maxAtomic,
    expiresAt: terms.expiresAt,
    state: PAYMENT_CHANNEL_STATES.OPEN,
    chargedAtomic: null,
  };
  // Durable before the only signature for this request exists.
  await journaled(() => options.journal.put(entry));
  // On any failure below the open never leaves the buyer, so its unsigned entry is dropped (or
  // pruned once the terms expire, if dropping fails too).
  const abandon = async (code: PaymentErrorCode): Promise<never> => {
    await options.journal.remove(terms.requestDigest).catch(() => undefined);
    return fail(code);
  };
  let signed: Awaited<ReturnType<typeof createUptoAuthorization>>;
  try {
    signed = await createUptoAuthorization(options.payer, channel, hints);
  } catch {
    return abandon(PAYMENT_ERROR_CODES.UNAVAILABLE);
  }
  try {
    await options.journal.put({ ...entry, channelId: signed.channelId });
  } catch {
    return abandon(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
  }
  return { ...signed, requestDigest: terms.requestDigest };
}

// A policy the buyer could never honor is a configuration error, refused at construction.
function checkedPolicy(policy: UptoBuyerPolicy): UptoBuyerPolicy {
  if (
    !ATOMIC.test(policy.maxAtomic) ||
    !isAddress(policy.mint) ||
    !isAddress(policy.treasury) ||
    !Number.isSafeInteger(policy.protocolFeeBps)
  )
    return fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  return policy;
}

export function createUptoPaymentClient(
  options: UptoPaymentClientOptions,
): PaymentClient {
  checkedPolicy(options.policy);
  // Requests being authorized now, so a concurrent call for the same one is refused before any await.
  const reserved = new Set<string>();
  return {
    async authorize(terms) {
      if (!trusted(terms, options.policy, options.payer.address, options.now()))
        fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
      if (reserved.has(terms.requestDigest))
        fail(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED);
      reserved.add(terms.requestDigest);
      try {
        const known = await options.journal
          .get(terms.requestDigest)
          .catch(() => fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE));
        if (known) fail(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED);
        return await signOpen(options, terms);
      } finally {
        reserved.delete(terms.requestDigest);
      }
    },
    async checkReceipt(authorization, settlement, expectedChargedAtomic) {
      const entry = await options.journal
        .get(authorization.requestDigest)
        .catch(() => fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE));
      if (!entry || entry.channelId !== authorization.channelId)
        fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
      if (entry.state === PAYMENT_CHANNEL_STATES.SETTLED)
        fail(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
      const channel = {
        channelId: entry.channelId,
        maxAtomic: entry.maxAtomic,
      };
      const onChain = await options
        .confirm(settlement, channel)
        .catch(() => fail(PAYMENT_ERROR_CODES.UNAVAILABLE));
      if (
        !onChain ||
        onChain.channelId !== channel.channelId ||
        settlement.channelId !== channel.channelId ||
        onChain.chargedAtomic !== settlement.chargedAtomic ||
        onChain.refundedAtomic !== settlement.refundedAtomic ||
        onChain.sellerAtomic !== settlement.sellerAtomic ||
        onChain.feeAtomic !== settlement.feeAtomic ||
        settlement.chargedAtomic !== expectedChargedAtomic ||
        BigInt(onChain.chargedAtomic) + BigInt(onChain.refundedAtomic) !==
          BigInt(channel.maxAtomic)
      )
        fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
      await journaled(() =>
        options.journal.put({
          ...entry,
          state: PAYMENT_CHANNEL_STATES.SETTLED,
          chargedAtomic: settlement.chargedAtomic,
        }),
      );
    },
    async reconcile() {
      const entries = await options.journal
        .list()
        .catch(() => fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE));
      // An entry without a channel never left the buyer: there is nothing to reconcile.
      return entries.flatMap(
        ({ channelId, requestDigest, state, chargedAtomic }) =>
          channelId ? [{ channelId, requestDigest, state, chargedAtomic }] : [],
      );
    },
  };
}
