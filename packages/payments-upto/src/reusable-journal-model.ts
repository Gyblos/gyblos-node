// Strict, bounded persisted state and voucher verification for the reusable buyer journal.
// This module never signs, sends, reads a chain or touches the existing payment journal.
import { PAYMENT_BINDING } from '@gyblos/protocol/constants';

import {
  REUSABLE_JOURNAL,
  REUSABLE_JOURNAL_STATES,
  REUSABLE_OPEN_WIRE,
} from './constants';
import { isJournalNetwork } from './journal-network';
import { parseClosure } from './reusable-journal-closure-model';
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
import {
  address,
  atomic,
  digest,
  fields,
  unavailable,
} from './reusable-journal-validation';

export type {
  ReusableChannelTerms,
  ReusableVoucher,
  ReusablePending,
  ReusableChannelEntry,
  NeverOpenedRecord,
  NeverOpenedObservation,
  FinalizedOpenObservation,
  PreparationObservation,
  PreparedOpeningObservation,
  ClosedChannelObservation,
  ReusableClosureRecord,
} from './reusable-journal-types';

export { atomic, digest, unavailable } from './reusable-journal-validation';

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
function isPreparationTombstone(
  status: unknown,
  terms: ReusableChannelTerms,
): boolean {
  return (
    status === REUSABLE_JOURNAL_STATES.NOT_OPENED &&
    terms.channelId === terms.buyer &&
    terms.salt === '0'
  );
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
      BigInt(terminal.contextSlot) <=
        BigInt(terms.openSlot) + BigInt(REUSABLE_OPEN_WIRE.openSlotWindow) ||
      terminal.contextSlot !== atomic(raw.lastObservedSlot) ||
      !(await verifyNeverOpened(terms, terminal))
    )
      unavailable();
  } else if (terminal) unavailable();
  return terminal;
}
function checkIdentity(
  status: unknown,
  terms: ReusableChannelTerms,
  authorizedAtomic: string,
  seen: Seen,
): void {
  const preparationTombstone = isPreparationTombstone(status, terms);
  if (
    (!preparationTombstone && seen.channels.has(terms.channelId)) ||
    BigInt(authorizedAtomic) > BigInt(terms.depositAtomic)
  )
    unavailable();
  if (!preparationTombstone) seen.channels.add(terms.channelId);
  const relation = JSON.stringify([
    terms.network,
    terms.mint,
    terms.buyer,
    terms.sellerNodeId,
  ]);
  if (
    status !== REUSABLE_JOURNAL_STATES.NOT_OPENED &&
    status !== REUSABLE_JOURNAL_STATES.CLOSED &&
    status !== REUSABLE_JOURNAL_STATES.CLOSED_REDIRECTED
  ) {
    if (seen.relationships.has(relation)) unavailable();
    seen.relationships.add(relation);
  }
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
      'closure',
      'vouchers',
    ]) ||
    (raw.status !== REUSABLE_JOURNAL_STATES.PREPARING &&
      raw.status !== REUSABLE_JOURNAL_STATES.OPENING &&
      raw.status !== REUSABLE_JOURNAL_STATES.READY &&
      raw.status !== REUSABLE_JOURNAL_STATES.CLOSED &&
      raw.status !== REUSABLE_JOURNAL_STATES.CLOSED_REDIRECTED &&
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
  const closure = await parseClosure(
    raw,
    terms,
    authorizedAtomic,
    hold,
    vouchers,
  );
  checkIdentity(raw.status, terms, authorizedAtomic, seen);
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
    closure,
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
