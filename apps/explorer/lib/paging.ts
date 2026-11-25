import { txCursor } from './chain-txs-shape';
import { CHAIN_TXS, IDENTITY, PAGES, PAGING, RANGE, STATS } from './constants';
import { numberedPager } from './pager-view';
import { pageOf, type Page, type TableSort } from './paging-rows';
import {
  hasRangeAlias,
  parseRange,
  presetRange,
  RANGE_SECTIONS,
  rangeValue,
  type RangeDays,
  type RangeSection,
} from './range';

export {
  pageOf,
  sortedRows,
  type Sortable,
  type Page,
  type TableSort,
} from './paging-rows';
export { numberedPager } from './pager-view';

export type PagedTable = keyof typeof PAGING.params;
export type TablePages = Partial<Record<PagedTable, number>>;
export type SearchSource =
  URLSearchParams | Record<string, string | string[] | undefined>;

export type SectionRanges = Partial<Record<RangeSection, RangeDays>>;
export type SortedTable = keyof typeof PAGING.sortParams;
export type TableSorts = Partial<Record<SortedTable, TableSort>>;

export type StatsMetric = keyof typeof STATS.metrics;
export type StatsTab = (typeof STATS.tabs)[number];

const isMetric = (value: unknown): value is StatsMetric =>
  typeof value === 'string' && Object.hasOwn(STATS.metrics, value);

export interface ExplorerQuery {
  tab?: StatsTab;
  metric?: StatsMetric;
  overviewTables?: boolean;
  path: string;
  days: RangeDays;
  ranges: SectionRanges;
  closed?: boolean;
  sorts: TableSorts;
  verified: boolean;
  before: string | null;
  pages: TablePages;
}

export interface QueryChange {
  days?: RangeDays;
  ranges?: SectionRanges;
  sorts?: Partial<Record<SortedTable, TableSort | null>>;
  verified?: boolean;
  before?: string | null;
  pages?: TablePages;
}

export interface PagerView {
  rows: string | null;
  page: number;
  pages: number;
  hrefs: Record<number, string>;
  showPages: boolean;
  previousLabel: string;
  nextLabel: string;
}

const isPagedTable = (key: string): key is PagedTable =>
  Object.hasOwn(PAGING.params, key);
const PAGED_TABLES = Object.keys(PAGING.params).filter(isPagedTable);
const SORTED_TABLES = Object.keys(PAGING.sortParams) as SortedTable[];

function parseSort(table: SortedTable, value: unknown): TableSort | undefined {
  if (typeof value !== 'string') return undefined;
  const desc = value.startsWith(PAGING.descendingPrefix);
  const key = desc ? value.slice(PAGING.descendingPrefix.length) : value;
  const keys: readonly string[] = PAGING.sortKeys[table];
  return keys.includes(key) ? { key, desc } : undefined;
}
const sortText = (sort: TableSort) =>
  `${sort.desc ? PAGING.descendingPrefix : ''}${sort.key}`;

const TABLE_PAGES: Record<PagedTable, string> = {
  sellers: PAGES.sellers,
  offline: PAGES.sellers,
  models: PAGES.models,
  daily: PAGES.stats,
  demand: PAGES.stats,
  chainDaily: PAGES.stats,
  transactions: PAGES.transactions,
};
const MOVED_PARAMS: (readonly [string, string])[] = [
  ...PAGED_TABLES.map(
    (table) => [PAGING.params[table], TABLE_PAGES[table]] as const,
  ),
  ...SORTED_TABLES.map(
    (table) => [PAGING.sortParams[table], TABLE_PAGES[table]] as const,
  ),
  [RANGE.sections.models.param, PAGES.models],
  [RANGE.sections.usage.param, PAGES.stats],
  [RANGE.sections.payments.param, PAGES.stats],
  [CHAIN_TXS.param, PAGES.transactions],
];

export function movedHomeHref(source: SearchSource): string | null {
  const search = new URLSearchParams();
  const entries =
    source instanceof URLSearchParams ? [...source] : Object.entries(source);
  for (const [name, value] of entries)
    for (const item of [value ?? []].flat()) search.append(name, item);
  if (search.get(PAGING.overviewParam) === PAGING.overviewValue) return null;
  const moved = MOVED_PARAMS.find(([name]) => search.has(name));
  return moved ? `${moved[1]}?${search.toString()}` : null;
}
const PAGE = new RegExp(`^[1-9]\\d{0,${PAGING.maxPageDigits - 1}}$`);

export function parsePage(value: unknown): number {
  return typeof value === 'string' && PAGE.test(value) ? Number(value) : 1;
}

function readParam(source: SearchSource, name: string): unknown {
  if (!(source instanceof URLSearchParams)) return source[name];
  const values = source.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

export function readQuery(source: SearchSource, path = '/'): ExplorerQuery {
  const before = txCursor(readParam(source, CHAIN_TXS.param));
  const pages: TablePages = {};
  for (const table of PAGED_TABLES) {
    const page = parsePage(readParam(source, PAGING.params[table]));
    if (page > 1) pages[table] = page;
  }
  const ranges: SectionRanges = {};
  for (const section of RANGE_SECTIONS) {
    const days = presetRange(readParam(source, RANGE.sections[section].param));
    if (days) ranges[section] = days;
  }
  const sorts: TableSorts = {};
  for (const table of SORTED_TABLES) {
    const sort = parseSort(table, readParam(source, PAGING.sortParams[table]));
    if (sort) sorts[table] = sort;
  }
  const requestedMetric = readParam(source, STATS.metricParam);
  const metric = isMetric(requestedMetric) ? requestedMetric : undefined;
  const requestedTab = readParam(source, STATS.tabParam);
  const legacyPayments = [
    PAGING.params.chainDaily,
    PAGING.sortParams.chainDaily,
    RANGE.sections.payments.param,
  ].some((name) => readParam(source, name) !== undefined);
  const tab = metric
    ? STATS.metrics[metric]
    : (STATS.tabs.find((item) => item === requestedTab) ??
      (legacyPayments ? 'payments' : 'usage'));
  return {
    ...(path === PAGES.stats ? { tab } : {}),
    ...(metric && (path === PAGES.network || path === PAGES.stats)
      ? { metric }
      : {}),
    ...(readParam(source, PAGING.overviewParam) === PAGING.overviewValue
      ? { overviewTables: true }
      : {}),
    path,
    days:
      (path === PAGES.stats ? ranges[tab] : undefined) ??
      parseRange(readParam(source, RANGE.param)),
    ranges,
    ...(path === PAGES.stats ||
    ((path === PAGES.models ||
      path === PAGES.sellers ||
      path.startsWith(`${PAGES.models}/`) ||
      path.startsWith(`${PAGES.sellers}/`)) &&
      readParam(source, RANGE.closedParam) === '1')
      ? { closed: true }
      : {}),
    sorts,
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
  if (change.before === null && !change.pages?.transactions)
    delete pages.transactions;
  const ranges = { ...query.ranges, ...change.ranges };
  const sorts = { ...query.sorts, ...change.sorts };
  const params = new URLSearchParams();
  if (query.tab === 'payments') params.set(STATS.tabParam, query.tab);
  if (query.metric) params.set(STATS.metricParam, query.metric);
  if (query.closed) params.set(RANGE.closedParam, '1');
  if (days !== RANGE.defaultDays) params.set(RANGE.param, rangeValue(days));
  for (const section of RANGE_SECTIONS) {
    const shown = ranges[section];
    if (shown && (shown !== days || section === 'chart'))
      params.set(RANGE.sections[section].param, rangeValue(shown));
  }
  if (verified) params.set(IDENTITY.verifiedParam, IDENTITY.verifiedValue);
  if (before) params.set(CHAIN_TXS.param, before);
  for (const table of PAGED_TABLES) {
    const page = pages[table] ?? 1;
    if (page > 1) params.set(PAGING.params[table], String(page));
  }
  for (const table of SORTED_TABLES) {
    const sort = sorts[table];
    if (sort) params.set(PAGING.sortParams[table], sortText(sort));
    else delete sorts[table];
  }
  if (
    query.path === PAGES.network &&
    query.overviewTables &&
    (before || (pages.transactions ?? 1) > 1 || pages.sellers || sorts.sellers)
  )
    params.set(PAGING.overviewParam, PAGING.overviewValue);
  const search = params.toString();
  return search ? `${query.path}?${search}` : query.path;
}

export function statsBreakdownHref(metric: StatsMetric, days: RangeDays) {
  const tab = STATS.metrics[metric];
  return (
    queryHref({ ...readQuery({}, PAGES.stats), days, tab, metric }) +
    '#' +
    (tab === 'payments' ? PAGING.anchors.chainDaily : PAGING.anchors.daily)
  );
}

export function canonicalPageHref(
  source: SearchSource,
  path = '/',
): string | null {
  const query = readQuery(source, path);
  const dropped =
    hasRangeAlias((param) => readParam(source, param)) ||
    PAGED_TABLES.some(
      (table) =>
        readParam(source, PAGING.params[table]) !== undefined &&
        query.pages[table] === undefined,
    ) ||
    RANGE_SECTIONS.some(
      (section) =>
        readParam(source, RANGE.sections[section].param) !== undefined &&
        query.ranges[section] === undefined,
    ) ||
    SORTED_TABLES.some(
      (table) =>
        readParam(source, PAGING.sortParams[table]) !== undefined &&
        query.sorts[table] === undefined,
    );
  return dropped ? queryHref(query) : null;
}

export function sortHref(
  query: ExplorerQuery,
  table: SortedTable,
  key: string,
  ascendingFirst = false,
): string {
  const current = query.sorts[table];
  const next =
    current?.key !== key
      ? { key, desc: !ascendingFirst }
      : current.desc !== ascendingFirst
        ? { key, desc: ascendingFirst }
        : null;
  return `${queryHref(query, { sorts: { [table]: next }, pages: { [table]: 1 } })}#${PAGING.anchors[table]}`;
}

export const rangeOf = (query: ExplorerQuery, section: RangeSection) =>
  query.ranges[section] ?? query.days;

export function directoryHref(
  path: typeof PAGES.models | typeof PAGES.sellers,
  query: ExplorerQuery,
  section: RangeSection,
) {
  return queryHref(
    { ...readQuery({}, path), closed: query.closed },
    { days: rangeOf(query, section) },
  );
}

export function sectionRangeHref(
  search: string,
  section: RangeSection,
  days: RangeDays,
  path = '/',
): string {
  const query = readQuery(new URLSearchParams(search), path);
  if (path === PAGES.stats)
    return queryHref(
      { ...query, ranges: {} },
      { days, pages: { daily: 1, demand: 1, chainDaily: 1 } },
    );
  const pages = Object.fromEntries(
    RANGE.sections[section].tables.map((table) => [table, 1]),
  );
  return queryHref(query, { ranges: { [section]: days }, pages });
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

export function tablePager(
  query: ExplorerQuery,
  table: PagedTable,
  page: Page<unknown>,
): PagerView {
  return numberedPager(page, (target) =>
    anchored(queryHref(query, { pages: { [table]: target } }), table),
  );
}

export function txPager(query: ExplorerQuery, page: Page<unknown>): PagerView {
  const table = PAGING.cursorTable;
  return numberedPager(page, (target) =>
    anchored(
      queryHref(query, {
        before: null,
        pages: { [table]: target },
      }),
      table,
    ),
  );
}
