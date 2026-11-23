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
  requested: number;
  page: number;
  pages: number;
  total: number;
  first: number;
  last: number;
}

export interface PagerLink {
  label: string;
  href: string;
  available: boolean;
}

export interface PagerView {
  rows: string | null;
  links: PagerLink[];
}

const isPagedTable = (key: string): key is PagedTable =>
  Object.hasOwn(PAGING.params, key);
const PAGED_TABLES = Object.keys(PAGING.params).filter(isPagedTable);
const isRangeTable = (table: PagedTable) =>
  PAGING.rangeTables.some((candidate) => candidate === table);
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
    if (page > 1 && (table !== PAGING.cursorTable || before))
      pages[table] = page;
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
    if (page > 1 && (table !== PAGING.cursorTable || before))
      params.set(PAGING.params[table], String(page));
  }
  const search = params.toString();
  return search ? `/?${search}` : '/';
}

export function canonicalPageHref(source: SearchSource): string | null {
  const query = readQuery(source);
  const dropped = PAGED_TABLES.some(
    (table) =>
      readParam(source, PAGING.params[table]) !== undefined &&
      query.pages[table] === undefined,
  );
  return dropped ? queryHref(query) : null;
}

export function rangeSwitchHref(search: string, days: RangeDays): string {
  const query = readQuery(new URLSearchParams(search));
  const pages = Object.fromEntries(
    PAGED_TABLES.filter(isRangeTable).map((table) => [table, 1]),
  );
  return queryHref(query, { days, pages });
}

export function pageOf<T>(rows: readonly T[], requested: number): Page<T> {
  const pages = Math.max(1, Math.ceil(rows.length / PAGING.rowsPerPage));
  const page = requested >= 1 && requested <= pages ? requested : 1;
  const start = (page - 1) * PAGING.rowsPerPage;
  const shown = rows.slice(start, start + PAGING.rowsPerPage);
  return {
    rows: shown,
    requested,
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

export function pageRedirect(
  query: ExplorerQuery,
  table: PagedTable,
  page: Page<unknown>,
  complete = true,
): string | null {
  return !complete || page.requested === page.page
    ? null
    : queryHref(query, { pages: { [table]: page.page } });
}

const anchored = (href: string, table: PagedTable) =>
  `${href}#${PAGING.anchors[table]}`;

const rowSpan = (first: number, last: number) =>
  `Rows ${count(first)}–${count(last)}`;

export function tablePager(
  query: ExplorerQuery,
  table: PagedTable,
  page: Page<unknown>,
): PagerView | null {
  if (page.pages <= 1) return null;
  const link = (label: string, target: number, available: boolean) => ({
    label,
    href: anchored(
      queryHref(query, {
        pages: { [table]: available ? target : page.page },
      }),
      table,
    ),
    available,
  });
  const earlier = page.page > 1;
  return {
    rows: `${rowSpan(page.first, page.last)} of ${count(page.total)}`,
    links: [
      link('First', 1, earlier),
      link('Previous', page.page - 1, earlier),
      link('Next', page.page + 1, page.page < page.pages),
    ],
  };
}

export function txPager(
  query: ExplorerQuery,
  shown: number,
  older: string | null,
): PagerView | null {
  if (!query.before && !older) return null;
  const page = query.before ? (query.pages.transactions ?? null) : 1;
  const table = PAGING.cursorTable;
  const newest = queryHref(query, { before: null });
  const next = queryHref(query, {
    before: older,
    pages: { [table]: page === null ? 1 : page + 1 },
  });
  const current = anchored(queryHref(query), table);
  const links: PagerLink[] = [
    {
      label: 'Newest',
      href: query.before ? anchored(newest, table) : current,
      available: query.before !== null,
    },
    {
      label: 'Older',
      href: older ? anchored(next, table) : current,
      available: older !== null,
    },
  ];
  const first = page === null ? 0 : (page - 1) * CHAIN_TXS.pageRows + 1;
  return {
    rows: page === null || !shown ? null : rowSpan(first, first + shown - 1),
    links,
  };
}
