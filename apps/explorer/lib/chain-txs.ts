import { unstable_cache } from 'next/cache';

import {
  chainTxsUrl,
  operationBefore,
  operationId,
  parseChainTxs,
  type ChainTxPage,
} from './chain-txs-shape';
import { COLLECTOR_URL } from './config';
import { CHAIN_TXS } from './constants';
import { fetchJson } from './fetch-json';
import { txPager, type ExplorerQuery } from './paging';

export async function getChainTxs(
  before: string | null,
  recipient: string | null = null,
  limit: number = CHAIN_TXS.pageRows,
): Promise<ChainTxPage> {
  try {
    return {
      ...parseChainTxs(
        await fetchJson(
          chainTxsUrl(COLLECTOR_URL, before, recipient, limit),
          'collector chain transactions',
        ),
      ),
      error: null,
    };
  } catch (error) {
    return {
      programId: '',
      treasury: '',
      transactions: [],
      next: null,
      error:
        error instanceof Error
          ? error.message
          : 'chain transactions unavailable',
    };
  }
}

const transactionIndex = unstable_cache(
  async (recipient: string | null, collector: string) => {
    const boundaries: (string | null)[] = [null];
    const visited = new Set<string>();
    let total = 0;
    let first: string | null = null;
    let cursor: string | null = null;
    let previous: string | null = null;
    do {
      const batch = parseChainTxs(
        await fetchJson(
          chainTxsUrl(collector, cursor, recipient, CHAIN_TXS.indexBatchRows),
          'collector transaction index',
        ),
      );
      for (const tx of batch.transactions) {
        if (total && total % CHAIN_TXS.pageRows === 0)
          boundaries.push(previous);
        previous = operationId(tx);
        first ??= previous;
        total++;
      }
      cursor = batch.next;
      if (cursor && visited.has(cursor))
        throw new Error('Repeated transaction cursor');
      if (cursor) visited.add(cursor);
    } while (cursor);
    return { boundaries, first, total };
  },
  ['explorer-operation-pages'],
  { revalidate: 60 },
);

function precedes(left: string, right: string) {
  const [slot, signature, instruction] = left.split('-');
  const [otherSlot, otherSignature, otherInstruction] = right.split('-');
  if (slot !== otherSlot) return Number(slot) > Number(otherSlot);
  if (signature !== otherSignature) return signature! > otherSignature!;
  return Number(instruction) > Number(otherInstruction);
}

export async function getTransactionTable(
  query: ExplorerQuery,
  recipient: string | null = null,
) {
  try {
    const { boundaries, first, total } = await transactionIndex(
      recipient,
      COLLECTOR_URL,
    );
    const before = query.before;
    const following = before
      ? boundaries.findIndex(
          (boundary) => boundary && precedes(before, boundary),
        )
      : 1;
    const current = following < 0 ? boundaries.length : following;
    const cursor = boundaries[current - 1];
    const batch = await getChainTxs(
      cursor ?? (first && operationBefore(first)),
      recipient,
    );
    const start = (current - 1) * CHAIN_TXS.pageRows;
    const page = {
      page: current,
      pages: boundaries.length,
      requested: current,
      rows: batch.transactions,
      total,
      first: start + 1,
      last: start + batch.transactions.length,
    };
    return { ...batch, pager: txPager(query, page, boundaries) };
  } catch {
    const page = {
      page: 1,
      pages: 1,
      requested: 1,
      rows: [],
      total: 0,
      first: 0,
      last: 0,
    };
    return {
      programId: '',
      treasury: '',
      transactions: [],
      next: null,
      error: 'Transaction index unavailable',
      pager: txPager(query, page, [null]),
    };
  }
}
