import type { ReactNode } from 'react';

import { HashScroll } from './hash-scroll';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

export function PageFrame({
  title,
  crumb,
  children,
}: {
  title: string;
  crumb?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <SiteHeader title={title} crumb={crumb} />
      {children}
      <SiteFooter />
      <HashScroll />
    </div>
  );
}
