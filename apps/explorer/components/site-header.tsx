import { Search } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { SEARCH_TERM_LIMIT } from '../lib/constants';
import { LiveRefresh } from './live-refresh';
import { NavLinks } from './nav-links';
import { NetworkSelect } from './network-select';

export function SiteHeader({ crumb }: { crumb?: ReactNode }) {
  return (
    <header className="border-b border-line">
      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link href="/" className="flex items-baseline gap-3">
            <span className="text-title-2-medium tracking-tight">gyblos</span>
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <LiveRefresh updatedAt={Date.now()} />
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
          className="flex min-h-11 items-center rounded-lg border border-line bg-panel pr-2 focus-within:ring-2 focus-within:ring-signal sm:pointer-fine:min-h-8"
        >
          <button
            type="submit"
            aria-label="Search Explorer"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal sm:pointer-fine:size-8"
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
            className="min-h-11 min-w-0 w-full bg-transparent text-base sm:pointer-fine:min-h-8 sm:text-sm outline-none sm:w-36"
          />
        </form>
      </div>
    </header>
  );
}
