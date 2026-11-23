import {
  CHANNEL_PROGRAM,
  DEVNET,
  DEVNET_GYBLOS_TREASURY,
  DEVNET_USDC,
} from '@gyblos/config/network';

import { CHAIN_TX_PAGE, type ChainInstructionKind } from './constants';

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
  splitGyblosFee: string | null;
  splitProgramFee: string | null;
  splitRefunded: string | null;
}
type SplitColumns =
  'splitPaidOut' | 'splitGyblosFee' | 'splitProgramFee' | 'splitRefunded';
export interface PayoutSplit {
  paidOut: string;
  gyblosFee: string;
  programFee: string;
  refunded: string;
}
export interface ChainTxReader {
  transactions(page: {
    before: ChainTxCursor | null;
    rows: number;
  }): Promise<ChainTxRow[]>;
}
export type ChainTx = Omit<ChainTxRow, 'recipientsJson' | SplitColumns> & {
  recipients: string[];
  split: PayoutSplit | null;
};
export interface ChainTxPage {
  network: string;
  programId: string;
  mint: string;
  treasury: string;
  transactions: ChainTx[];
  next: string | null;
}
export interface ChainTxQuery {
  before: ChainTxCursor | null;
  limit: number;
}

const CURSOR =
  /^(0|[1-9]\d{0,14})-([1-9A-HJ-NP-Za-km-z]{32,88})-(0|[1-9]\d{0,2})$/;
const LIMIT = /^[1-9]\d{0,2}$/;
const PARAMS = CHAIN_TX_PAGE.params;
const PARAM_ORDER: readonly string[] = [PARAMS.BEFORE, PARAMS.LIMIT];

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
  if (limit === undefined || before === undefined) return undefined;
  return { before, limit };
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

function payoutSplit(row: Pick<ChainTxRow, SplitColumns>): PayoutSplit | null {
  const { splitPaidOut, splitGyblosFee, splitProgramFee, splitRefunded } = row;
  if (
    splitPaidOut === null ||
    splitGyblosFee === null ||
    splitProgramFee === null ||
    splitRefunded === null
  )
    return null;
  return {
    paidOut: splitPaidOut,
    gyblosFee: splitGyblosFee,
    programFee: splitProgramFee,
    refunded: splitRefunded,
  };
}

export async function chainTransactions(
  reader: ChainTxReader,
  query: ChainTxQuery,
): Promise<ChainTxPage> {
  const rows = await reader.transactions({
    before: query.before,
    rows: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    network: DEVNET,
    programId: CHANNEL_PROGRAM,
    mint: DEVNET_USDC,
    treasury: DEVNET_GYBLOS_TREASURY,
    transactions: page.map(
      ({
        recipientsJson,
        splitPaidOut,
        splitGyblosFee,
        splitProgramFee,
        splitRefunded,
        ...row
      }) => ({
        ...row,
        recipients: recipientOwners(recipientsJson),
        split: payoutSplit({
          splitPaidOut,
          splitGyblosFee,
          splitProgramFee,
          splitRefunded,
        }),
      }),
    ),
    next: rows.length > query.limit && last ? cursorOf(last) : null,
  };
}
