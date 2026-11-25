import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { readComparison } from '../../components/activity-report';
import { PageFrame } from '../../components/page-frame';
import { PaymentsSection } from '../../components/payments-section';
import { RangeControl } from '../../components/range-control';
import { Loading } from '../../components/ui';
import { UsageSection } from '../../components/usage-section';
import { PAGES } from '../../lib/constants';
import { pageMetadata } from '../../lib/page-meta';
import { canonicalPageHref, readQuery } from '../../lib/paging';

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
  const report = readComparison(query.days, Date.now());
  return (
    <PageFrame
      title="Stats"
      toolbar={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-caption-1-medium text-text-tertiary">
            Complete UTC days
          </span>
          <RangeControl section="usage" days={query.days} />
        </div>
      }
    >
      <div className="mt-5 space-y-8 sm:space-y-10">
        <Suspense fallback={<Loading cards />}>
          <UsageSection query={query} reportPromise={report} />
        </Suspense>
        <Suspense fallback={<Loading cards />}>
          <PaymentsSection query={query} reportPromise={report} />
        </Suspense>
      </div>
    </PageFrame>
  );
}
