import { PAGE_LINKS, PAGES } from './constants';

const detailSections = new Set<string>([
  PAGES.sellers,
  PAGES.models,
  PAGES.transactions,
]);
export const isCurrentPage = (pathname: string, href: string) =>
  pathname === href ||
  (detailSections.has(href) && pathname.startsWith(`${href}/`));

export const currentPage = (pathname: string) =>
  PAGE_LINKS.find((link) => isCurrentPage(pathname, link.href));

interface MetricColumn {
  label: string;
  group?: string;
  compactGroup?: string;
}

export function compactColumnGroups(columns: readonly MetricColumn[]) {
  return columns.map((column, index) =>
    index === 0 ? null : (column.compactGroup ?? column.group ?? column.label),
  );
}

const FIVE_SPANS = [
  'col-span-2 lg:col-span-2 xl:col-span-1',
  'lg:col-span-2 xl:col-span-1',
  'lg:col-span-2 xl:col-span-1',
  'lg:col-span-3 xl:col-span-1',
  'lg:col-span-3 xl:col-span-1',
];
export const FULL_OVERVIEW = FIVE_SPANS.length;

export function overviewLayout(cards: number) {
  if (cards === FULL_OVERVIEW)
    return {
      grid: 'grid grid-cols-2 gap-3 lg:grid-cols-6 xl:grid-cols-5',
      spans: FIVE_SPANS,
    };
  return {
    grid: 'grid grid-cols-2 gap-3 xl:grid-cols-4',
    spans: Array.from({ length: cards }, () => ''),
  };
}
