import { count } from './format';
import type { Page, PagerView } from './paging';

export const rowSpan = (first: number, last: number) =>
  `Rows ${count(first)}–${count(last)}`;

const PAGER_WINDOW = 2;
const PAGER_EDGE = 5;

export function numberedPager(
  page: Page<unknown>,
  href: (target: number) => string,
): PagerView {
  const targets = new Set<number>();
  for (let offset = 0; offset < PAGER_EDGE; offset++) {
    targets.add(1 + offset);
    targets.add(page.pages - offset);
  }
  for (let offset = -PAGER_WINDOW; offset <= PAGER_WINDOW; offset++)
    targets.add(page.page + offset);
  const hrefs: Record<number, string> = {};
  for (const target of targets)
    if (target >= 1 && target <= page.pages) hrefs[target] = href(target);
  return {
    rows: page.total
      ? `${rowSpan(page.first, page.last)} of ${count(page.total)}`
      : '0 rows',
    page: page.page,
    pages: page.pages,
    hrefs,
    showPages: true,
    previousLabel: 'Previous',
    nextLabel: 'Next',
  };
}
