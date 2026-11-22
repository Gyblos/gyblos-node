import { CHANNEL_PROGRAM, DEVNET, DEVNET_USDC } from '@gyblos/config/network';

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
}
export interface ChainTxReader {
  transactions(page: {
    before: ChainTxCursor | null;
    rows: number;
  }): Promise<ChainTxRow[]>;
}
export type ChainTx = Omit<ChainTxRow, 'recipientsJson'> & {
  recipients: string[];
};
export interface ChainTxPage {
  network: string;
  programId: string;
  mint: string;
  transactions: ChainTx[];
  next: string | null;
}
export interface ChainTxQuery {
  before: ChainTxCursor | null;
  limit: number;
}

const CURSOR = /^(\d{1,15})-([1-9A-HJ-NP-Za-km-z]{32,88})-(\d{1,3})$/;
const LIMIT = /^[1-9]\d{0,2}$/;
const PARAMS = CHAIN_TX_PAGE.params;
const KNOWN_PARAMS: ReadonlySet<string> = new Set(Object.values(PARAMS));

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
  return limit <= CHAIN_TX_PAGE.maxLimit ? limit : undefined;
}

export function parseChainTxQuery(
  params: URLSearchParams,
): ChainTxQuery | undefined {
  const keys = [...params.keys()];
  if (
    keys.some((key) => !KNOWN_PARAMS.has(key)) ||
    new Set(keys).size !== keys.length
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
    transactions: page.map(({ recipientsJson, ...row }) => ({
      ...row,
      recipients: recipientOwners(recipientsJson),
    })),
    next: rows.length > query.limit && last ? cursorOf(last) : null,
  };
}
