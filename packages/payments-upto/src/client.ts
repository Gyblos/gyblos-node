// The buyer's PaymentClient over x402-upto-metered: trusts only terms within its own policy (never the
// seller's fee or treasury), journals each request before signing its one channel open, and accepts a
// receipt only when the chain shows that settlement for its own metering.
import { isAddress, type TransactionSigner } from '@solana/kit';
import {
  createUptoAuthorization,
  createUptoReceiptReader,
  decodeUptoPayload,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoClientHints,
  type UptoTransactionRpc,
} from 'x402-upto-metered';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
  PUBLIC_RECORD_LIMITS,
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
import { networkRecoveryBlock, snapshotJournal } from './journal-network';
import { assertPaymentNetworkEnabled } from './mainnet';
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
  channel: { channelId: string; maxAtomic: string; payTo: string },
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

const ATOMIC = /^(0|[1-9][0-9]{0,19})$/;
const DISTINCT_PARTIES = 4;
// The chain's u64 ceiling for any atomic amount.
const U64_MAX = BigInt(PUBLIC_RECORD_LIMITS.maxAtomic);
// A canonical atomic amount that fits the chain's u64.
const atomic = (value: string) =>
  ATOMIC.test(value) && BigInt(value) <= U64_MAX;
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
    // Payout, fee payer, buyer and fee treasury are four different accounts: the fee payer signs and
    // pays the open, and the receipt check tells each party's payment apart by its owner.
    new Set([terms.payTo, terms.feePayer, payer, policy.treasury]).size ===
      DISTINCT_PARTIES &&
    terms.protocolFeeBps === policy.protocolFeeBps &&
    terms.treasury === policy.treasury &&
    terms.buyer === payer &&
    atomic(terms.maxAtomic) &&
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
    payTo: terms.payTo,
    feePayer: terms.feePayer,
    maxAtomic: terms.maxAtomic,
    // What the open signs for: trusted terms carry exactly the policy's mint, treasury and rate.
    policy: {
      network: terms.network,
      mint: terms.mint,
      treasury: terms.treasury,
      protocolFeeBps: terms.protocolFeeBps,
    },
    openSlot: hints.recentSlot,
    lastValidBlockHeight: hints.lastValidBlockHeight,
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
  const authorization = { ...signed, requestDigest: terms.requestDigest };
  try {
    // The slot the open itself names, which its channel address derives from.
    const { openSlot } = decodeUptoPayload(signed);
    await options.journal.put({
      ...entry,
      channelId: signed.channelId,
      openSlot,
    });
  } catch {
    // A write can land and still report failure (the directory sync after the rename); the open is
    // then journaled and must be returned rather than stranded as a signed entry nobody holds.
    const held = await options.journal
      .get(terms.requestDigest)
      .catch(() => undefined);
    if (held?.channelId === signed.channelId) return authorization;
    return abandon(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
  }
  return authorization;
}

// A policy the buyer could never honor is a configuration error, refused at construction.
function checkedPolicy(policy: UptoBuyerPolicy): UptoBuyerPolicy {
  assertPaymentNetworkEnabled(policy.network);
  if (
    !atomic(policy.maxAtomic) ||
    !isAddress(policy.mint) ||
    !isAddress(policy.treasury) ||
    !Number.isSafeInteger(policy.protocolFeeBps)
  )
    return fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  return policy;
}

// Drops a signed entry the caller knows never left the buyer; a settled one, or another channel's
// identity, is refused.
async function discardUnsent(
  journal: UptoBuyerJournal,
  inputAuthorization: PaymentAuthorization,
  network: string,
) {
  const authorization = { ...inputAuthorization };
  const entry = await journal
    .get(authorization.requestDigest)
    .catch(() => fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE));
  if (!entry) return;
  if (networkRecoveryBlock(entry, network))
    fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  if (entry.channelId !== authorization.channelId)
    fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
  if (entry.state === PAYMENT_CHANNEL_STATES.SETTLED)
    fail(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
  await journal
    .remove(authorization.requestDigest, authorization.channelId)
    .catch(() => fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE));
}

async function checkReceipt(
  fixed: UptoPaymentClientOptions,
  inputAuthorization: PaymentAuthorization,
  inputSettlement: PaymentSettlement,
  expectedChargedAtomic: string,
): Promise<void> {
  const authorization = { ...inputAuthorization };
  const settlement = { ...inputSettlement };
  const observed = await fixed.journal
    .get(authorization.requestDigest)
    .catch(() => fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE));
  const entry = observed
    ? { ...observed, policy: observed.policy ? { ...observed.policy } : null }
    : undefined;
  if (
    !entry ||
    entry.channelId !== authorization.channelId ||
    networkRecoveryBlock(entry, fixed.policy.network)
  )
    fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
  if (entry.state === PAYMENT_CHANNEL_STATES.SETTLED)
    fail(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
  const channel = {
    channelId: entry.channelId,
    maxAtomic: entry.maxAtomic,
    payTo: entry.payTo,
  };
  const onChain = await fixed
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
    fixed.journal.put({
      ...entry,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: settlement.chargedAtomic,
    }),
  );
}

export function createUptoPaymentClient(
  options: UptoPaymentClientOptions,
): PaymentClient {
  const fixed = {
    ...options,
    journal: snapshotJournal(options.journal),
    policy: { ...options.policy },
    settings: { ...options.settings },
  };
  checkedPolicy(fixed.policy);
  // Requests being authorized now, so a concurrent call for the same one is refused before any await.
  const reserved = new Set<string>();
  return {
    async authorize(input) {
      const terms = { ...input };
      if (!trusted(terms, fixed.policy, fixed.payer.address, fixed.now()))
        fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
      if (reserved.has(terms.requestDigest))
        fail(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED);
      reserved.add(terms.requestDigest);
      try {
        const known = await fixed.journal
          .get(terms.requestDigest)
          .catch(() => fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE));
        if (known) fail(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED);
        return await signOpen(fixed, terms);
      } finally {
        reserved.delete(terms.requestDigest);
      }
    },
    checkReceipt: (authorization, settlement, expectedChargedAtomic) =>
      checkReceipt(fixed, authorization, settlement, expectedChargedAtomic),
    async reconcile() {
      const entries = await fixed.journal
        .list()
        .catch(() => fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE));
      // An entry without a channel never left the buyer: there is nothing to reconcile.
      return entries.flatMap(
        ({ channelId, requestDigest, state, chargedAtomic }) =>
          channelId ? [{ channelId, requestDigest, state, chargedAtomic }] : [],
      );
    },
    discard: (authorization) =>
      discardUnsent(fixed.journal, authorization, fixed.policy.network),
  };
}

// The settlement view over the chain: what the claim transaction itself paid this buyer (the signer),
// the seller and the policy's fee treasury; built from the client's own policy and signer.
export function uptoSettlementView(
  rpc: UptoTransactionRpc,
  policy: Pick<UptoBuyerPolicy, 'mint' | 'treasury'>,
  payer: TransactionSigner,
): UptoSettlementView {
  const reader = createUptoReceiptReader(rpc);
  return (settlement, channel) =>
    reader.settlement({
      transaction: settlement.transaction,
      channelId: channel.channelId,
      mint: policy.mint,
      maxAtomic: channel.maxAtomic,
      payer: payer.address,
      payTo: channel.payTo,
      treasury: policy.treasury,
    });
}
