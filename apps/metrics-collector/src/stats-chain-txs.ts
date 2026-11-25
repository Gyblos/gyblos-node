import {
  CHANNEL_PROGRAM,
  DEVNET,
  DEVNET_GYBLOS_TREASURY,
  DEVNET_USDC,
} from '@gyblos/config/network';

import { base58Decode, base58Encode } from './chain/base58';
import {
  CHAIN_LAYOUT,
  CHAIN_TX_PAGE,
  type ChainInstructionKind,
} from './constants';

export interface ChainTxCursor {
  slot: number;
  signature: string;
  instructionIndex: number;
}
export interface ChainTxRow extends ChainTxCursor {
  blockTime: number | null;
  kind: ChainInstructionKind;
  channel: string;
  payee: string | null;
  recipientsJson: string | null;
  amountAtomic: string | null;
  splitPaidOut: string | null;
  splitGyblosFees: string | null;
  splitProgramTreasury: string | null;
  splitRefunded: string | null;
  splitChannels: number | null;
  splitUnclassified: string | null;
  batched: number;
}
type SplitColumns =
  | 'splitPaidOut'
  | 'splitGyblosFees'
  | 'splitProgramTreasury'
  | 'splitRefunded'
  | 'splitChannels'
  | 'splitUnclassified';
export interface PayoutSplit {
  paidOut: string;
  gyblosFees: string;
  programTreasury: string;
  refunded: string;
  channels: number;
  unclassified: string;
}
export interface NumberedChainTxPage {
  page: number;
  total: number;
  rows: ChainTxRow[];
}

export interface ChainTxReader {
  numberedTransactions(
    query: ChainTxQuery,
    page: number,
  ): Promise<NumberedChainTxPage>;
  transactions(page: {
    before: ChainTxCursor | null;
    rows: number;
    recipient: string | null;
  }): Promise<ChainTxRow[]>;
}
export type ChainTx = Omit<
  ChainTxRow,
  'recipientsJson' | 'batched' | SplitColumns
> & {
  recipients: string[];
  split: PayoutSplit | null;
  batched: boolean;
};
export interface ChainTxPage {
  network: string;
  programId: string;
  mint: string;
  treasury: string;
  transactions: ChainTx[];
  next: string | null;
  total?: number;
  page?: number;
}
export interface ChainTxQuery {
  page?: number;
  before: ChainTxCursor | null;
  limit: number;
  recipient: string | null;
}

const CURSOR =
  /^(0|[1-9]\d{0,14})-([1-9A-HJ-NP-Za-km-z]{32,88})-(0|[1-9]\d{0,2})$/;
const LIMIT = /^[1-9]\d{0,2}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PARAMS = CHAIN_TX_PAGE.params;
const PARAM_ORDER: readonly string[] = [
  PARAMS.BEFORE,
  PARAMS.LIMIT,
  PARAMS.RECIPIENT,
  PARAMS.PAGE,
];

export const cursorOf = (row: ChainTxCursor) =>
  `${row.slot}-${row.signature}-${row.instructionIndex}`;

function parseCursor(value: string): ChainTxCursor | undefined {
  const match = CURSOR.exec(value);
  if (!match) return undefined;
  return {
    slot: Number(match[1]),
    signature: match[2]!,
    instructionIndex: Number(match[3]),
  };
}
function parseLimit(value: string | null): number | undefined {
  if (value === null) return CHAIN_TX_PAGE.defaultLimit;
  if (!LIMIT.test(value)) return undefined;
  const limit = Number(value);
  return limit <= CHAIN_TX_PAGE.maxLimit && limit !== CHAIN_TX_PAGE.defaultLimit
    ? limit
    : undefined;
}

function parseRecipient(value: string | null): string | null | undefined {
  if (value === null) return null;
  if (!ADDRESS.test(value)) return undefined;
  const bytes = base58Decode(value);
  return bytes.length === CHAIN_LAYOUT.pubkeyBytes &&
    base58Encode(bytes) === value
    ? value
    : undefined;
}

export function parseChainTxQuery(
  params: URLSearchParams,
): ChainTxQuery | undefined {
  const keys = [...params.keys()];
  const canonical = PARAM_ORDER.filter((key) => keys.includes(key));
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  )
    return undefined;
  const limit = parseLimit(params.get(PARAMS.LIMIT));
  const text = params.get(PARAMS.BEFORE);
  const before = text === null ? null : parseCursor(text);
  const recipient = parseRecipient(params.get(PARAMS.RECIPIENT));
  if (limit === undefined || before === undefined || recipient === undefined)
    return undefined;
  const page = params.get(PARAMS.PAGE);
  if (page === null) return { before, limit, recipient };
  if (before || !/^[1-9]\d{0,5}$/.test(page)) return undefined;
  return { before, limit, recipient, page: Number(page) };
}

function recipientOwners(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown) => {
      const owner: unknown =
        entry && typeof entry === 'object'
          ? Reflect.get(entry, 'owner')
          : undefined;
      return typeof owner === 'string' ? [owner] : [];
    });
  } catch {
    return [];
  }
}

function payoutSplit(row: ChainTxRow): PayoutSplit | null {
  if (
    row.splitPaidOut === null ||
    row.splitGyblosFees === null ||
    row.splitProgramTreasury === null ||
    row.splitRefunded === null ||
    row.splitChannels === null ||
    row.splitUnclassified === null
  )
    return null;
  return {
    paidOut: row.splitPaidOut,
    gyblosFees: row.splitGyblosFees,
    programTreasury: row.splitProgramTreasury,
    refunded: row.splitRefunded,
    channels: row.splitChannels,
    unclassified: row.splitUnclassified,
  };
}

function chainTx(row: ChainTxRow): ChainTx {
  return {
    signature: row.signature,
    instructionIndex: row.instructionIndex,
    slot: row.slot,
    blockTime: row.blockTime,
    kind: row.kind,
    channel: row.channel,
    payee: row.payee,
    recipients: recipientOwners(row.recipientsJson),
    amountAtomic: row.amountAtomic,
    split: payoutSplit(row),
    batched: row.batched === 1,
  };
}

export async function chainTransactions(
  reader: ChainTxReader,
  query: ChainTxQuery,
): Promise<ChainTxPage> {
  const numbered =
    query.page === undefined
      ? undefined
      : await reader.numberedTransactions(query, query.page);
  const rows =
    numbered?.rows ??
    (await reader.transactions({
      before: query.before,
      rows: query.limit + 1,
      recipient: query.recipient,
    }));
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    network: DEVNET,
    programId: CHANNEL_PROGRAM,
    mint: DEVNET_USDC,
    treasury: DEVNET_GYBLOS_TREASURY,
    ...(numbered && { total: numbered.total, page: numbered.page }),
    transactions: page.map(chainTx),
    next: rows.length > query.limit && last ? cursorOf(last) : null,
  };
}
