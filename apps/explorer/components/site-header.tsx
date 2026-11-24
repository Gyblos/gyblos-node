import Link from 'next/link';
import type { ReactNode } from 'react';

import { LiveRefresh } from './live-refresh';
import { NavLinks } from './nav-links';
import { NetworkSelect } from './network-select';

export function SiteHeader({
  title,
  crumb,
}: {
  title: string;
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
          <LiveRefresh />
          <NetworkSelect />
        </div>
      </div>
      <nav aria-label="Explorer" className="pb-3">
        <NavLinks />
      </nav>
    </header>
  );
}
