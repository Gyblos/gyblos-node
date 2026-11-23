import { explorerTxUrl } from './config';
import { CHAIN_TXS, DISPLAY, IDENTITY, RANGE } from './constants';
import { short, usdcFixed, utcMinute } from './format';
import type { RangeDays } from './range';
import {
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
}
export interface PayoutSplit {
  paidOut: bigint;
  gyblosFee: bigint;
  programFee: bigint;
  refunded: bigint;
}
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

function kind(value: unknown): ChainTxKind {
  const read = text(value, 'tx.kind');
  const known = CHAIN_TX_KINDS.find((candidate) => candidate === read);
  if (!known) throw new SourceShapeError('tx.kind');
  return known;
}

function payoutSplit(value: unknown): PayoutSplit {
  const source = record(value, 'tx.split');
  const part = (key: keyof PayoutSplit) =>
    BigInt(integerText(source[key], `tx.split.${key}`));
  return {
    paidOut: part('paidOut'),
    gyblosFee: part('gyblosFee'),
    programFee: part('programFee'),
    refunded: part('refunded'),
  };
}

function transaction(value: unknown): ChainTx {
  const source = record(value, 'tx');
  return {
    signature: text(source.signature, 'tx.signature'),
    instructionIndex: num(source.instructionIndex, 'tx.instructionIndex'),
    slot: num(source.slot, 'tx.slot'),
    blockTime: nullable(source.blockTime, (present) =>
      num(present, 'tx.blockTime'),
    ),
    kind: kind(source.kind),
    channel: text(source.channel, 'tx.channel'),
    recipients: list(source.recipients, 'tx.recipients').map((owner) =>
      text(owner, 'tx.recipient'),
    ),
    amount: nullable(source.amountAtomic, (present) =>
      BigInt(integerText(present, 'tx.amountAtomic')),
    ),
    split: nullable(source.split, payoutSplit),
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

export function chainTxsQuery(before: string | null) {
  const params = new URLSearchParams();
  if (before) params.set(CHAIN_TXS.param, before);
  return params.toString();
}

export function chainTxsUrl(collector: string, before: string | null) {
  const query = chainTxsQuery(before);
  return `${collector}/stats/chain/txs${query ? `?${query}` : ''}`;
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

function splitText(split: PayoutSplit | null) {
  if (!split) return null;
  const parts: [string, bigint][] = [
    ['fee', split.gyblosFee],
    ['program', split.programFee],
    ['refunded', split.refunded],
  ];
  return [
    `seller ${usdcFixed(split.paidOut)}`,
    ...parts.flatMap(([label, value]) =>
      value ? [`${label} ${usdcFixed(value)}`] : [],
    ),
  ].join(' · ');
}

function amountText(tx: ChainTx) {
  if (tx.amount === null) return '—';
  if (tx.amount === 0n && SETTLING.includes(tx.kind)) return NO_CHANGE;
  return usdcFixed(tx.amount);
}

export function txRow(
  tx: ChainTx,
  owners: ReadonlyMap<string, ListedOwner>,
  treasury: string,
) {
  const payTo = tx.recipients[0] ?? null;
  return {
    key: `${tx.signature}:${tx.instructionIndex}`,
    time: utcMinute(tx.blockTime),
    kind: tx.kind,
    label: CHAIN_TX_LABELS[tx.kind],
    channel: tx.channel,
    payTo,
    seller: payTo && payTo !== treasury ? (owners.get(payTo) ?? null) : null,
    amount: amountText(tx),
    muted: tx.amount === null || amountText(tx) === NO_CHANGE,
    detail: splitText(tx.split),
    signature: short(
      tx.signature,
      DISPLAY.signatureEdge,
      DISPLAY.signatureEdge,
    ),
    href: explorerTxUrl(tx.signature),
  };
}

export function txPageHref(
  days: RangeDays,
  before: string | null,
  verified = false,
) {
  const params = new URLSearchParams();
  if (days !== RANGE.defaultDays) params.set(RANGE.param, String(days));
  if (verified) params.set(IDENTITY.verifiedParam, IDENTITY.verifiedValue);
  if (before) params.set(CHAIN_TXS.param, before);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

export function rangeSwitchHref(search: string, days: RangeDays) {
  const params = new URLSearchParams(search);
  return txPageHref(
    days,
    txCursor(params.get(CHAIN_TXS.param)),
    params.get(IDENTITY.verifiedParam) === IDENTITY.verifiedValue,
  );
}
