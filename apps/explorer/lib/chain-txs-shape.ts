import { explorerTxUrl } from './config';
import { CHAIN_TXS, DISPLAY, RANGE } from './constants';
import type { Seller } from './discovery-shape';
import { short, usdc, utcMinute } from './format';
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

export interface ChainTx {
  signature: string;
  instructionIndex: number;
  slot: number;
  blockTime: number | null;
  kind: ChainTxKind;
  channel: string;
  payee: string | null;
  recipients: string[];
  amount: bigint | null;
}
export interface ChainTxPage {
  programId: string;
  transactions: ChainTx[];
  next: string | null;
  error: string | null;
}

const CURSOR = /^\d{1,15}-[1-9A-HJ-NP-Za-km-z]{32,88}-\d{1,3}$/;

export function txCursor(value: unknown): string | null {
  return typeof value === 'string' && CURSOR.test(value) ? value : null;
}

function kind(value: unknown): ChainTxKind {
  const read = text(value, 'tx.kind');
  const known = CHAIN_TX_KINDS.find((candidate) => candidate === read);
  if (!known) throw new SourceShapeError('tx.kind');
  return known;
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
    payee: nullable(source.payee, (present) => text(present, 'tx.payee')),
    recipients: list(source.recipients, 'tx.recipients').map((owner) =>
      text(owner, 'tx.recipient'),
    ),
    amount: nullable(source.amountAtomic, (present) =>
      BigInt(integerText(present, 'tx.amountAtomic')),
    ),
  };
}

export function parseChainTxs(value: unknown): Omit<ChainTxPage, 'error'> {
  const body = record(value, 'txs');
  return {
    programId: text(body.programId, 'txs.programId'),
    transactions: list(body.transactions, 'txs.transactions').map(transaction),
    next: nullable(body.next, (present) => {
      const cursor = txCursor(present);
      if (!cursor) throw new SourceShapeError('txs.next');
      return cursor;
    }),
  };
}

export const sellerOwners = (sellers: Pick<Seller, 'nodeId' | 'owner'>[]) =>
  new Map(sellers.map((seller) => [seller.owner, seller.nodeId]));

export function txRow(tx: ChainTx, owners: ReadonlyMap<string, string>) {
  const paid = [...tx.recipients, ...(tx.payee ? [tx.payee] : [])];
  const owner = paid.find((address) => owners.has(address));
  return {
    key: `${tx.signature}:${tx.instructionIndex}`,
    time: utcMinute(tx.blockTime),
    kind: tx.kind,
    channel: tx.channel,
    seller: owner ? (owners.get(owner) ?? null) : null,
    payee: tx.payee,
    amount: tx.amount === null ? '—' : usdc(tx.amount),
    signature: short(
      tx.signature,
      DISPLAY.signatureEdge,
      DISPLAY.signatureEdge,
    ),
    href: explorerTxUrl(tx.signature),
  };
}

export function txPageHref(days: RangeDays, before: string | null) {
  const params = new URLSearchParams();
  if (days !== RANGE.defaultDays) params.set(RANGE.param, String(days));
  if (before) params.set(CHAIN_TXS.param, before);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}
