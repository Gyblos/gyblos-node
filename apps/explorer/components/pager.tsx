import Link from 'next/link';

import type { PagerView } from '../lib/paging';

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
      className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 font-mono text-xs text-muted"
    >
      <span>{view.rows}</span>
      <span className="flex flex-wrap gap-4">
        {view.links.map((link) => (
          <Link
            key={link.label}
            className="hover:text-brand"
            href={link.href}
            scroll={false}
          >
            {link.label}
          </Link>
        ))}
      </span>
    </nav>
  );
}
