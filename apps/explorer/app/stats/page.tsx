import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { PageFrame } from '../../components/page-frame';
import { PaymentsSection } from '../../components/payments-section';
import { RangeControl } from '../../components/range-control';
import { StatsTabs } from '../../components/stats-tabs';
import { Loading } from '../../components/ui';
import { UsageSection } from '../../components/usage-section';
import { PAGES } from '../../lib/constants';
import { pageMetadata } from '../../lib/page-meta';
import { canonicalPageHref, readQuery, statsTabHref } from '../../lib/paging';

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
    <PageFrame title="Stats">
      <div className="my-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted">
          Through the last complete UTC day
        </span>
        <RangeControl section="usage" days={query.days} />
      </div>
      <StatsTabs
        selected={query.tab ?? 'usage'}
        usageHref={statsTabHref(query, 'usage')}
        paymentsHref={statsTabHref(query, 'payments')}
      >
        <Suspense
          key={JSON.stringify([query.tab, query.days, query.metric])}
          fallback={<Loading cards />}
        >
          {query.tab === 'payments' ? (
            <PaymentsSection query={query} />
          ) : (
            <UsageSection query={query} />
          )}
        </Suspense>
      </StatsTabs>
    </PageFrame>
  );
}
