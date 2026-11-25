import type { ReactNode } from 'react';

import { HashScroll } from './hash-scroll';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

export function PageFrame({
  title,
  crumb,
  overview,
  children,
}: {
  title: ReactNode;
  overview?: boolean;
  crumb?: ReactNode;
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
      <SiteHeader overview={overview} crumb={crumb} />
      <main id="main-content" tabIndex={-1}>
        <h1 className="mt-6 text-title-1-medium break-words text-text-primary sm:mt-8">
          {title}
        </h1>
        {children}
      </main>
      <SiteFooter />
      <HashScroll />
    </div>
  );
}
