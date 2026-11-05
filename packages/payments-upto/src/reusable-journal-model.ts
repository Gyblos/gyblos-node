// Strict, bounded persisted state and voucher verification for the reusable buyer journal.
// This module never signs, sends, reads a chain or touches the existing payment journal.
import { isAddress } from '@solana/kit';

import {
  PAYMENT_BINDING,
  PAYMENT_ERROR_CODES,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import { REUSABLE_JOURNAL, REUSABLE_JOURNAL_STATES } from './constants';
import { isJournalNetwork } from './journal-network';
import {
  verifyBinding,
  verifyNeverOpened,
  verifyTerms,
  verifyVoucher,
} from './reusable-journal-crypto';
import type {
  NeverOpenedRecord,
  ReusableChannelEntry,
  ReusableChannelTerms,
  ReusablePending,
  ReusableVoucher,
} from './reusable-journal-types';

export type {
  ReusableChannelTerms,
  ReusableVoucher,
  ReusablePending,
  ReusableChannelEntry,
  NeverOpenedRecord,
  NeverOpenedObservation,
  FinalizedOpenObservation,
} from './reusable-journal-types';

export function unavailable(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function address(value: unknown): string {
  return typeof value === 'string' && isAddress(value) ? value : unavailable();
}
export function digest(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    ? value
    : unavailable();
}
export function atomic(value: unknown): string {
  return typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= BigInt(PUBLIC_RECORD_LIMITS.maxAtomic)
    ? value
    : unavailable();
}
const TERMS_FIELDS = [
  'channelId',
  'buyer',
  'sellerNodeId',
  'payTo',
  'feePayer',
  'treasury',
  'mint',
  'network',
  'protocolFeeBps',
  'depositAtomic',
  'openSlot',
  'lastValidBlockHeight',
  'recentBlockhash',
  'salt',
  'gracePeriod',
  'tokenProgram',
] as const;
export function parseTerms(value: unknown): ReusableChannelTerms {
  if (
    !fields(value, TERMS_FIELDS) ||
    !isJournalNetwork(value.network) ||
    typeof value.protocolFeeBps !== 'number' ||
    !Number.isInteger(value.protocolFeeBps) ||
    value.protocolFeeBps < 0 ||
    value.protocolFeeBps > PAYMENT_BINDING.maxFeeBps ||
    atomic(value.depositAtomic) === '0' ||
    typeof value.gracePeriod !== 'number' ||
    !Number.isSafeInteger(value.gracePeriod) ||
    value.gracePeriod < 1 ||
    value.gracePeriod > REUSABLE_JOURNAL.maxGracePeriod
  )
    unavailable();
  return {
    channelId: address(value.channelId),
    buyer: address(value.buyer),
    sellerNodeId: digest(value.sellerNodeId),
    payTo: address(value.payTo),
    feePayer: address(value.feePayer),
    treasury: address(value.treasury),
    mint: address(value.mint),
    network: value.network,
    protocolFeeBps: value.protocolFeeBps,
    depositAtomic: atomic(value.depositAtomic),
    openSlot: atomic(value.openSlot),
    lastValidBlockHeight: atomic(value.lastValidBlockHeight),
    recentBlockhash: address(value.recentBlockhash),
    salt: atomic(value.salt),
    gracePeriod: value.gracePeriod,
    tokenProgram: address(value.tokenProgram),
  };
}
function pending(value: unknown): ReusablePending {
  if (
    !fields(value, [
      'requestDigest',
      'maxClaimableAmount',
      'bindingSignature',
    ]) ||
    typeof value.bindingSignature !== 'string' ||
    value.bindingSignature.length > REUSABLE_JOURNAL.signatureChars
  )
    return unavailable();
  return {
    requestDigest: digest(value.requestDigest),
    maxClaimableAmount: atomic(value.maxClaimableAmount),
    bindingSignature: value.bindingSignature,
  };
}

function voucher(value: unknown): ReusableVoucher {
  if (
    !fields(value, [
      'requestDigest',
      'maxClaimableAmount',
      'signature',
      'bindingSignature',
    ]) ||
    typeof value.signature !== 'string' ||
    value.signature.length > REUSABLE_JOURNAL.signatureChars ||
    typeof value.bindingSignature !== 'string' ||
    value.bindingSignature.length > REUSABLE_JOURNAL.signatureChars
  )
    return unavailable();
  return {
    ...pending({
      requestDigest: value.requestDigest,
      maxClaimableAmount: value.maxClaimableAmount,
      bindingSignature: value.bindingSignature,
    }),
    signature: value.signature,
    bindingSignature: value.bindingSignature,
  };
}
interface Seen {
  channels: Set<string>;
  requests: Set<string>;
  relationships: Set<string>;
}
async function checkHistory(
  terms: ReusableChannelTerms,
  authorizedAtomic: string,
  hold: ReusablePending | null,
  vouchers: ReusableVoucher[],
  seen: Seen,
): Promise<void> {
  let previous = 0n;
  for (const item of vouchers) {
    const amount = BigInt(item.maxClaimableAmount);
    if (
      seen.requests.has(item.requestDigest) ||
      amount <= previous ||
      amount > BigInt(authorizedAtomic) ||
      !(await verifyVoucher(terms, item))
    )
      unavailable();
    seen.requests.add(item.requestDigest);
    previous = amount;
  }
  if (
    hold &&
    (seen.requests.has(hold.requestDigest) ||
      BigInt(hold.maxClaimableAmount) <= previous ||
      hold.maxClaimableAmount !== authorizedAtomic ||
      !(await verifyBinding(terms, hold)))
  )
    unavailable();
  if (hold) seen.requests.add(hold.requestDigest);
  if (!hold && previous !== BigInt(authorizedAtomic)) unavailable();
}
async function parseTerminal(
  raw: Record<string, unknown>,
  terms: ReusableChannelTerms,
  authorizedAtomic: string,
  hold: ReusablePending | null,
  vouchers: ReusableVoucher[],
): Promise<NeverOpenedRecord | null> {
  let terminal: NeverOpenedRecord | null = null;
  if (raw.terminal !== null) {
    if (
      !fields(raw.terminal, [
        'contextSlot',
        'finalizedBlockHeight',
        'signature',
      ]) ||
      typeof raw.terminal.signature !== 'string' ||
      raw.terminal.signature.length > REUSABLE_JOURNAL.signatureChars
    )
      unavailable();
    terminal = {
      contextSlot: atomic(raw.terminal.contextSlot),
      finalizedBlockHeight: atomic(raw.terminal.finalizedBlockHeight),
      signature: raw.terminal.signature,
    };
  }
  if (raw.status === REUSABLE_JOURNAL_STATES.NOT_OPENED) {
    if (
      !terminal ||
      hold ||
      vouchers.length ||
      authorizedAtomic !== '0' ||
      BigInt(terminal.finalizedBlockHeight) <=
        BigInt(terms.lastValidBlockHeight) ||
      terminal.contextSlot !== atomic(raw.lastObservedSlot) ||
      !(await verifyNeverOpened(terms, terminal))
    )
      unavailable();
  } else if (terminal) unavailable();
  return terminal;
}
async function parseEntry(
  raw: unknown,
  seen: Seen,
): Promise<ReusableChannelEntry> {
  if (
    !fields(raw, [
      'terms',
      'status',
      'termsSignature',
      'lastObservedSlot',
      'authorizedAtomic',
      'pending',
      'terminal',
      'vouchers',
    ]) ||
    (raw.status !== REUSABLE_JOURNAL_STATES.PREPARING &&
      raw.status !== REUSABLE_JOURNAL_STATES.OPENING &&
      raw.status !== REUSABLE_JOURNAL_STATES.READY &&
      raw.status !== REUSABLE_JOURNAL_STATES.NOT_OPENED) ||
    !Array.isArray(raw.vouchers) ||
    raw.vouchers.length > REUSABLE_JOURNAL.maxVouchersPerChannel
  )
    return unavailable();
  const terms = parseTerms(raw.terms);
  if (
    typeof raw.termsSignature !== 'string' ||
    raw.termsSignature.length > REUSABLE_JOURNAL.signatureChars ||
    !(await verifyTerms(terms, raw.termsSignature))
  )
    unavailable();
  const authorizedAtomic = atomic(raw.authorizedAtomic);
  const hold = raw.pending === null ? null : pending(raw.pending);
  const vouchers = raw.vouchers.map(voucher);
  const terminal = await parseTerminal(
    raw,
    terms,
    authorizedAtomic,
    hold,
    vouchers,
  );
  if (
    seen.channels.has(terms.channelId) ||
    BigInt(authorizedAtomic) > BigInt(terms.depositAtomic)
  )
    unavailable();
  seen.channels.add(terms.channelId);
  const relation = JSON.stringify([
    terms.network,
    terms.mint,
    terms.buyer,
    terms.sellerNodeId,
  ]);
  if (raw.status !== REUSABLE_JOURNAL_STATES.NOT_OPENED) {
    if (seen.relationships.has(relation)) unavailable();
    seen.relationships.add(relation);
  }
  if (
    (raw.status === REUSABLE_JOURNAL_STATES.OPENING ||
      raw.status === REUSABLE_JOURNAL_STATES.PREPARING) &&
    (hold || vouchers.length)
  )
    unavailable();
  if (
    raw.status === REUSABLE_JOURNAL_STATES.PREPARING &&
    (terms.channelId !== terms.buyer || terms.salt !== '0')
  )
    unavailable();
  await checkHistory(terms, authorizedAtomic, hold, vouchers, seen);
  return {
    terms,
    status: raw.status,
    termsSignature: raw.termsSignature,
    lastObservedSlot: atomic(raw.lastObservedSlot),
    authorizedAtomic,
    pending: hold,
    terminal,
    vouchers,
  };
}
export async function parseDocument(
  source: string,
): Promise<ReusableChannelEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return unavailable();
  }
  if (
    !fields(parsed, ['version', 'entries']) ||
    parsed.version !== REUSABLE_JOURNAL.version ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length > REUSABLE_JOURNAL.maxChannels
  )
    unavailable();
  const entries: ReusableChannelEntry[] = [];
  const seen: Seen = {
    channels: new Set(),
    requests: new Set(),
    relationships: new Set(),
  };
  for (const raw of parsed.entries) entries.push(await parseEntry(raw, seen));
  return entries;
}
