import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { PageFrame } from '../../components/page-frame';
import { PaymentsSection } from '../../components/payments-section';
import { Loading } from '../../components/ui';
import { UsageSection } from '../../components/usage-section';
import { PAGES } from '../../lib/constants';
import { pageMetadata } from '../../lib/page-meta';
import { canonicalPageHref, rangeOf, readQuery } from '../../lib/paging';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata(
  'Stats',
  PAGES.stats,
  'Gyblos usage and payments over a range: free and paid requests, success, latency, unserved demand, settled USDC, fees and refunds per day.',
);

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const canonical = canonicalPageHref(params, PAGES.stats);
  if (canonical) redirect(canonical);
  const query = readQuery(params, PAGES.stats);
  return (
    <PageFrame title="Gyblos network stats">
      <Suspense
        key={`usage-${rangeOf(query, 'usage')}`}
        fallback={<Loading cards />}
      >
        <UsageSection query={query} />
      </Suspense>
      <Suspense
        key={`payments-${rangeOf(query, 'payments')}`}
        fallback={<Loading cards />}
      >
        <PaymentsSection query={query} />
      </Suspense>
    </PageFrame>
  );
}
