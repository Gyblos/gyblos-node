import {
  chainTxsUrl,
  parseChainTxs,
  type ChainTxPage,
} from './chain-txs-shape';
import { COLLECTOR_URL } from './config';
import { CHAIN_TXS, PAGING } from './constants';
import { fetchJson } from './fetch-json';
import { queryHref, txPager, type ExplorerQuery } from './paging';
import { num, record, SourceShapeError } from './validate';

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

function cursorPager(query: ExplorerQuery, batch: ChainTxPage) {
  const page = query.before ? Math.max(2, query.pages.transactions ?? 2) : 1;
  const href = (before: string | null, target: number) =>
    queryHref(query, { before, pages: { transactions: target } }) +
    '#' +
    PAGING.anchors.transactions;
  const hrefs: Record<number, string> = {};
  if (query.before) hrefs[page - 1] = href(null, 1);
  if (batch.next) hrefs[page + 1] = href(batch.next, page + 1);
  return {
    page,
    pages: page + Number(Boolean(batch.next)),
    rows: null,
    hrefs,
    previousLabel: 'Newest',
    nextLabel: 'Older',
    showPages: !batch.next && !query.before,
  };
}

export async function getTransactionTable(
  query: ExplorerQuery,
  recipient: string | null = null,
) {
  const requested = query.pages.transactions ?? 1;
  if (!query.before) {
    const url = new URL(chainTxsUrl(COLLECTOR_URL, null, recipient));
    url.searchParams.set(CHAIN_TXS.pageParam, String(requested));
    try {
      const raw = await fetchJson(url.href, 'collector operation page');
      const body = record(raw, 'txs');
      const total = num(body.total, 'txs.total');
      const current = num(body.page, 'txs.page');
      const batch = parseChainTxs(body);
      const pages = Math.max(1, Math.ceil(total / CHAIN_TXS.pageRows));
      const start = (current - 1) * CHAIN_TXS.pageRows;
      if (
        !Number.isSafeInteger(total) ||
        total < 0 ||
        !Number.isSafeInteger(current) ||
        current < 1 ||
        current > pages ||
        batch.transactions.length !==
          Math.min(CHAIN_TXS.pageRows, total - start)
      )
        throw new SourceShapeError('txs.page');
      const page = {
        page: current,
        total,
        requested,
        pages,
        rows: batch.transactions,
        first: start + 1,
        last: start + batch.transactions.length,
      };
      return { ...batch, error: null, pager: txPager(query, page) };
    } catch {
      return getCursorTable(query, recipient);
    }
  }
  return getCursorTable(query, recipient);
}

async function getCursorTable(query: ExplorerQuery, recipient: string | null) {
  const batch = await getChainTxs(query.before, recipient);
  return { ...batch, pager: cursorPager(query, batch) };
}
