import { CHAIN_TXS, DISPLAY, PAGES, TX_TEXT } from './constants';
import { short, usdcFixed, utcMinute } from './format';
import {
  flag,
  integerText,
  list,
  nullable,
  num,
  record,
  SourceShapeError,
  text,
} from './validate';

export const CHAIN_TX_KINDS = [
  'open',
  'settle',
  'top_up',
  'settle_and_seal',
  'request_close',
  'seal',
  'distribute',
  'reclaim',
] as const;
export type ChainTxKind = (typeof CHAIN_TX_KINDS)[number];
export const CHAIN_TX_LABELS: Record<ChainTxKind, string> = {
  open: 'Deposit',
  top_up: 'Top-up',
  settle: 'Settle',
  settle_and_seal: 'Settle and close',
  request_close: 'Close requested',
  seal: 'Closed',
  distribute: 'Paid out',
  reclaim: 'Refunded',
};
const SETTLING: readonly ChainTxKind[] = ['settle', 'settle_and_seal'];
const NO_CHANGE = 'no change';

export interface ChainTx {
  signature: string;
  instructionIndex: number;
  slot: number;
  blockTime: number | null;
  kind: ChainTxKind;
  channel: string;
  recipients: string[];
  amount: bigint | null;
  split: PayoutSplit | null;
  batched: boolean;
}
export interface PayoutSplit {
  paidOut: bigint;
  gyblosFees: bigint;
  programTreasury: bigint;
  refunded: bigint;
  channels: number;
  unclassified: bigint;
}
type SplitPart = Exclude<keyof PayoutSplit, 'channels'>;
const SPLIT_COLUMNS = ['gyblosFees', 'programTreasury', 'refunded'] as const;
export type SplitColumn = (typeof SPLIT_COLUMNS)[number];
const MAIN_PART: Partial<Record<ChainTxKind, SplitPart>> = {
  distribute: 'paidOut',
  reclaim: 'refunded',
};
const PAYING = new Set(Object.keys(MAIN_PART));
export interface ChainTxPage {
  programId: string;
  treasury: string;
  transactions: ChainTx[];
  next: string | null;
  error: string | null;
}

const CURSOR =
  /^(0|[1-9]\d{0,14})-[1-9A-HJ-NP-Za-km-z]{32,88}-(0|[1-9]\d{0,2})$/;

export function txCursor(value: unknown): string | null {
  return typeof value === 'string' && CURSOR.test(value) ? value : null;
}

export const operationId = (
  tx: Pick<ChainTx, 'slot' | 'signature' | 'instructionIndex'>,
) => `${tx.slot}-${tx.signature}-${tx.instructionIndex}`;

export const operationHref = (tx: ChainTx) =>
  `${PAGES.transactions}/${operationId(tx)}`;

export function operationBefore(id: string): string | null {
  if (!txCursor(id)) return null;
  const [slot, signature, position] = id.split('-');
  return txCursor(`${slot}-${signature}-${Number(position) + 1}`);
}

function kind(value: unknown): ChainTxKind {
  const read = text(value, 'tx.kind');
  const known = CHAIN_TX_KINDS.find((candidate) => candidate === read);
  if (!known) throw new SourceShapeError('tx.kind');
  return known;
}

function payoutSplit(value: unknown): PayoutSplit {
  const source = record(value, 'tx.split');
  const part = (key: SplitPart) =>
    BigInt(integerText(source[key], `tx.split.${key}`));
  return {
    paidOut: part('paidOut'),
    gyblosFees: part('gyblosFees'),
    programTreasury: part('programTreasury'),
    refunded: part('refunded'),
    channels: num(source.channels, 'tx.split.channels'),
    unclassified: part('unclassified'),
  };
}

function transaction(value: unknown): ChainTx {
  const source = record(value, 'tx');
  const kindRead = kind(source.kind);
  const legacyPayout = PAYING.has(kindRead) && !('split' in source);
  return {
    signature: text(source.signature, 'tx.signature'),
    instructionIndex: num(source.instructionIndex, 'tx.instructionIndex'),
    slot: num(source.slot, 'tx.slot'),
    blockTime: nullable(source.blockTime, (present) =>
      num(present, 'tx.blockTime'),
    ),
    kind: kindRead,
    channel: text(source.channel, 'tx.channel'),
    recipients: list(source.recipients, 'tx.recipients').map((owner) =>
      text(owner, 'tx.recipient'),
    ),
    amount: legacyPayout
      ? null
      : nullable(source.amountAtomic, (present) =>
          BigInt(integerText(present, 'tx.amountAtomic')),
        ),
    split: nullable(source.split, payoutSplit),
    batched:
      source.batched === undefined ? false : flag(source.batched, 'tx.batched'),
  };
}

export function parseChainTxs(value: unknown): Omit<ChainTxPage, 'error'> {
  const body = record(value, 'txs');
  return {
    programId: text(body.programId, 'txs.programId'),
    treasury: text(body.treasury, 'txs.treasury'),
    transactions: list(body.transactions, 'txs.transactions').map(transaction),
    next: nullable(body.next, (present) => {
      const cursor = txCursor(present);
      if (!cursor) throw new SourceShapeError('txs.next');
      return cursor;
    }),
  };
}

export function chainTxsQuery(
  before: string | null,
  recipient: string | null = null,
  limit: number = CHAIN_TXS.pageRows,
) {
  const params = new URLSearchParams();
  if (before) params.set(CHAIN_TXS.param, before);
  params.set(CHAIN_TXS.limitParam, String(limit));
  if (recipient) params.set(CHAIN_TXS.recipientParam, recipient);
  return params.toString();
}

export function chainTxsUrl(
  collector: string,
  before: string | null,
  recipient: string | null = null,
  limit: number = CHAIN_TXS.pageRows,
) {
  const query = chainTxsQuery(before, recipient, limit);
  return `${collector}/stats/chain/txs?${query}`;
}

export interface ListedOwner {
  nodeId: string;
  owner: string;
}

export function sellerOwners(sellers: ListedOwner[]) {
  const nodes = new Map<string, Set<string>>();
  for (const seller of sellers)
    nodes.set(
      seller.owner,
      (nodes.get(seller.owner) ?? new Set()).add(seller.nodeId),
    );
  return new Map(
    [...nodes].flatMap(([owner, ids]) =>
      ids.size === 1 ? [[owner, { nodeId: [...ids][0]!, owner }] as const] : [],
    ),
  );
}

function splitParts(tx: ChainTx): Record<SplitColumn, string | null> {
  const main = MAIN_PART[tx.kind];
  const part = (key: SplitColumn) => {
    const value = tx.split?.[key];
    return !tx.batched && key !== main && value ? usdcFixed(value) : null;
  };
  return {
    gyblosFees: part('gyblosFees'),
    programTreasury: part('programTreasury'),
    refunded: part('refunded'),
  };
}

function splitNotes(tx: ChainTx): string[] {
  if (tx.batched) return [TX_TEXT.batched];
  if (!tx.split) return [];
  const notes =
    tx.split.channels > 1 ? [`total of ${tx.split.channels} channels`] : [];
  if (MAIN_PART[tx.kind] !== 'paidOut' && tx.split.paidOut)
    notes.push(`to sellers ${usdcFixed(tx.split.paidOut)}`);
  return tx.split.unclassified
    ? [...notes, `unclassified ${usdcFixed(tx.split.unclassified)}`]
    : notes;
}

function amountText(tx: ChainTx) {
  if (tx.amount === null) return '—';
  if ((tx.split?.channels ?? 1) > 1)
    return `${TX_TEXT.batchTotal} ${usdcFixed(tx.amount)}`;
  if (tx.amount === 0n && SETTLING.includes(tx.kind)) return NO_CHANGE;
  return usdcFixed(tx.amount);
}

export function txRow(
  tx: ChainTx,
  owners: ReadonlyMap<string, ListedOwner>,
  treasury: string,
) {
  const payTo = tx.recipients[0] ?? null;
  const shared = (tx.split?.channels ?? 1) > 1;
  return {
    key: `${tx.signature}:${tx.instructionIndex}`,
    time: utcMinute(tx.blockTime),
    kind: tx.kind,
    label: CHAIN_TX_LABELS[tx.kind],
    channel: tx.channel,
    payTo,
    seller:
      payTo && payTo !== treasury && !shared
        ? (owners.get(payTo) ?? null)
        : null,
    amount: amountText(tx),
    muted: !tx.amount || tx.kind !== 'distribute' || shared,
    parts: splitParts(tx),
    detail: splitNotes(tx),
    shared,
    signature: short(
      tx.signature,
      DISPLAY.signatureEdge,
      DISPLAY.signatureEdge,
    ),
    href: operationHref(tx),
  };
}
