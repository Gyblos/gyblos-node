import { PAGE_LINKS, PAGES } from './constants';

export const isCurrentPage = (pathname: string, href: string) =>
  href === PAGES.network
    ? pathname === href
    : pathname === href ||
      (href === PAGES.sellers && pathname.startsWith(`${PAGES.sellers}/`));

export const currentPage = (pathname: string) =>
  PAGE_LINKS.find((link) => isCurrentPage(pathname, link.href));

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
