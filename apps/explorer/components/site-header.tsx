import { Search } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { SEARCH_TERM_LIMIT } from '../lib/constants';
import { LiveRefresh } from './live-refresh';
import { NavLinks } from './nav-links';
import { NetworkSelect } from './network-select';

export function SiteHeader({
  title,
  crumb,
  overview,
}: {
  title: string;
  overview?: boolean;
  crumb?: ReactNode;
}) {
  return (
    <header className="border-b border-line">
      <h1 className="sr-only">{title}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3 py-5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link href="/" className="flex items-baseline gap-3">
            <span className="text-xl font-medium tracking-tight">gyblos</span>
            <span className="text-muted">Explorer</span>
          </Link>
          {crumb ? (
            <>
              <span aria-hidden className="text-dim">
                /
              </span>
              <span
                aria-current="page"
                className="font-mono text-sm text-muted"
              >
                {crumb}
              </span>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LiveRefresh quiet={overview} />
          <NetworkSelect />
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3 pb-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <nav aria-label="Explorer" className="min-w-0">
          <NavLinks />
        </nav>
        <form
          action="/search"
          role="search"
          className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-panel px-3 focus-within:border-signal sm:min-h-8"
        >
          <button
            type="submit"
            aria-label="Search Explorer"
            className="text-dim hover:text-ink"
          >
            <Search aria-hidden size={15} />
          </button>
          <input
            aria-label="Search models, labs, sellers, addresses or recent signatures"
            type="search"
            name="q"
            placeholder="Search Explorer"
            maxLength={SEARCH_TERM_LIMIT}
            required
            className="min-w-0 w-full bg-transparent text-sm outline-none sm:w-36"
          />
        </form>
      </div>
    </header>
  );
}
