import { txCursor } from './chain-txs-shape';
import { CHAIN_TXS, IDENTITY, PAGING, RANGE } from './constants';
import { count } from './format';
import { parseRange, type RangeDays } from './range';

export type PagedTable = keyof typeof PAGING.params;
export type TablePages = Partial<Record<PagedTable, number>>;
export type SearchSource =
  URLSearchParams | Record<string, string | string[] | undefined>;

export interface ExplorerQuery {
  days: RangeDays;
  verified: boolean;
  before: string | null;
  pages: TablePages;
}

export interface QueryChange {
  days?: RangeDays;
  verified?: boolean;
  before?: string | null;
  pages?: TablePages;
}

export interface Page<T> {
  rows: T[];
  page: number;
  pages: number;
  total: number;
  first: number;
  last: number;
}

export interface PagerLink {
  label: string;
  href: string;
}

export interface PagerView {
  rows: string | null;
  links: PagerLink[];
}

const PAGED_TABLES: readonly PagedTable[] = [
  'sellers',
  'offline',
  'models',
  'daily',
  'demand',
  'chainDaily',
  'transactions',
];
const PAGE = new RegExp(`^[1-9]\\d{0,${PAGING.maxPageDigits - 1}}$`);

export function parsePage(value: unknown): number {
  return typeof value === 'string' && PAGE.test(value) ? Number(value) : 1;
}

function readParam(source: SearchSource, name: string): unknown {
  if (!(source instanceof URLSearchParams)) return source[name];
  const values = source.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

export function readQuery(source: SearchSource): ExplorerQuery {
  const before = txCursor(readParam(source, CHAIN_TXS.param));
  const pages: TablePages = {};
  for (const table of PAGED_TABLES) {
    const page = parsePage(readParam(source, PAGING.params[table]));
    if (page > 1 && (table !== 'transactions' || before)) pages[table] = page;
  }
  return {
    days: parseRange(readParam(source, RANGE.param)),
    verified:
      readParam(source, IDENTITY.verifiedParam) === IDENTITY.verifiedValue,
    before,
    pages,
  };
}

export function queryHref(
  query: ExplorerQuery,
  change: QueryChange = {},
): string {
  const days = change.days ?? query.days;
  const verified = change.verified ?? query.verified;
  const before = change.before === undefined ? query.before : change.before;
  const pages = { ...query.pages, ...change.pages };
  const params = new URLSearchParams();
  if (days !== RANGE.defaultDays) params.set(RANGE.param, String(days));
  if (verified) params.set(IDENTITY.verifiedParam, IDENTITY.verifiedValue);
  if (before) params.set(CHAIN_TXS.param, before);
  for (const table of PAGED_TABLES) {
    const page = pages[table] ?? 1;
    if (page > 1 && (table !== 'transactions' || before))
      params.set(PAGING.params[table], String(page));
  }
  const search = params.toString();
  return search ? `/?${search}` : '/';
}

export function rangeSwitchHref(search: string, days: RangeDays): string {
  return queryHref(readQuery(new URLSearchParams(search)), { days });
}

export function pageOf<T>(rows: readonly T[], requested: number): Page<T> {
  const pages = Math.max(1, Math.ceil(rows.length / PAGING.rowsPerPage));
  const page = requested >= 1 && requested <= pages ? requested : 1;
  const start = (page - 1) * PAGING.rowsPerPage;
  const shown = rows.slice(start, start + PAGING.rowsPerPage);
  return {
    rows: shown,
    page,
    pages,
    total: rows.length,
    first: shown.length ? start + 1 : 0,
    last: start + shown.length,
  };
}

export function tablePage<T>(
  query: ExplorerQuery,
  table: PagedTable,
  rows: readonly T[],
): Page<T> {
  return pageOf(rows, query.pages[table] ?? 1);
}

const rowSpan = (first: number, last: number) =>
  `Rows ${count(first)}–${count(last)}`;

export function tablePager(
  query: ExplorerQuery,
  table: PagedTable,
  page: Page<unknown>,
): PagerView | null {
  if (page.pages <= 1) return null;
  const to = (target: number) =>
    queryHref(query, { pages: { [table]: target } });
  const links: PagerLink[] = [];
  if (page.page > 1)
    links.push(
      { label: 'First', href: to(1) },
      { label: 'Previous', href: to(page.page - 1) },
    );
  if (page.page < page.pages)
    links.push({ label: 'Next', href: to(page.page + 1) });
  return {
    rows: `${rowSpan(page.first, page.last)} of ${count(page.total)}`,
    links,
  };
}

export function txPager(
  query: ExplorerQuery,
  shown: number,
  older: string | null,
): PagerView | null {
  if (!query.before && !older) return null;
  const page = query.before ? (query.pages.transactions ?? null) : 1;
  const links: PagerLink[] = [];
  if (query.before)
    links.push({ label: 'Newest', href: queryHref(query, { before: null }) });
  if (older)
    links.push({
      label: 'Older',
      href: queryHref(query, {
        before: older,
        pages: { transactions: page === null ? 1 : page + 1 },
      }),
    });
  const first = page === null ? 0 : (page - 1) * CHAIN_TXS.pageRows + 1;
  return {
    rows: page === null || !shown ? null : rowSpan(first, first + shown - 1),
    links,
  };
}
