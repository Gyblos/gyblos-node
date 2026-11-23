import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  pageRedirect,
  tablePage,
  type ExplorerQuery,
  type PagedTable,
  type PagerView,
} from '../lib/paging';

const LINK = 'py-1 underline-offset-2 hover:text-brand hover:underline';
const UNAVAILABLE = 'pointer-events-none py-1 text-dim';

export function pagedRows<T>(
  query: ExplorerQuery,
  table: PagedTable,
  rows: readonly T[],
) {
  const page = tablePage(query, table, rows);
  const canonical = pageRedirect(query, table, page);
  if (canonical) redirect(canonical);
  return page;
}

export function Pager({
  label,
  view,
}: {
  label: string;
  view: PagerView | null;
}) {
  if (!view) return null;
  return (
    <nav
      aria-label={`${label} pages`}
      className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-xs text-muted"
    >
      <span>{view.rows}</span>
      <span className="flex flex-wrap gap-4">
        {view.links.map((link) => (
          <Link
            key={link.label}
            className={link.available ? LINK : UNAVAILABLE}
            href={link.href}
            aria-disabled={link.available ? undefined : 'true'}
            tabIndex={link.available ? undefined : -1}
          >
            {link.label}
          </Link>
        ))}
      </span>
    </nav>
  );
}
