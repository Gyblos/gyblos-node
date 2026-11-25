import { redirect } from 'next/navigation';

import { Pagination } from '../boardui/components/base/pagination/pagination';
import {
  pageRedirect,
  sortedRows,
  tablePage,
  type ExplorerQuery,
  type PagedTable,
  type PagerView,
  type Sortable,
  type SortedTable,
} from '../lib/paging';

export function pagedRows<T>(
  query: ExplorerQuery,
  table: PagedTable,
  rows: readonly T[],
  complete = true,
  by?: Record<string, (row: T) => Sortable>,
) {
  const sort =
    by && table in query.sorts ? query.sorts[table as SortedTable] : undefined;
  const page = tablePage(query, table, by ? sortedRows(rows, sort, by) : rows);
  const canonical = pageRedirect(query, table, page, complete);
  if (canonical) redirect(canonical);
  return page;
}

export function Pager({ label, view }: { label: string; view: PagerView }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-separator-border px-4 py-1.5">
      <span className="font-mono text-xs text-dim">{view.rows}</span>
      <Pagination
        aria-label={`${label} pages`}
        page={view.page}
        totalPages={view.pages}
        hrefs={view.hrefs}
        showPages={view.showPages}
        previousLabel={view.previousLabel}
        nextLabel={view.nextLabel}
      />
    </div>
  );
}
