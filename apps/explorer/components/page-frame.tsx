import type { ReactNode } from 'react';

import { HashScroll } from './hash-scroll';
import { QueryRegion } from './query-region';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

export function PageFrame({
  title,
  crumb,
  toolbar,
  children,
}: {
  title: ReactNode;
  crumb?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-7xl px-4 sm:px-6 lg:px-8">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-bg focus:px-4 focus:py-2 focus:text-ink focus:outline-2 focus:outline-offset-2 focus:outline-signal"
      >
        Skip to content
      </a>
      <SiteHeader crumb={crumb} />
      <main id="main-content" tabIndex={-1}>
        <QueryRegion>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h1 className="text-title-2-medium break-words text-text-primary">
              {title}
            </h1>
            {toolbar}
          </div>
          {children}
          <HashScroll />
        </QueryRegion>
      </main>
      <SiteFooter />
    </div>
  );
}
