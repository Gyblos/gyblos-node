import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { Overview } from '../components/overview';
import {
  OverviewOffers,
  OverviewOperations,
} from '../components/overview-evidence';
import { PageFrame } from '../components/page-frame';
import { QueryRegion } from '../components/query-region';
import { Loading } from '../components/ui';
import { canonicalPageHref, movedHomeHref, readQuery } from '../lib/paging';

// Every request renders. The collector caches its answers at its own edge (5 minutes); the discovery
// index is read into KV by the Worker's scheduled run, and renders read KV (lib/discovery-render.ts).
export const dynamic = 'force-dynamic';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const moved = movedHomeHref(params);
  if (moved) redirect(moved);
  const canonical = canonicalPageHref(params);
  if (canonical) redirect(canonical);
  const query = { ...readQuery(params), overviewTables: true };
  return (
    <PageFrame title="Network">
      <QueryRegion>
        <Suspense fallback={<Loading overview />}>
          <Overview query={query} />
        </Suspense>
      </QueryRegion>
      <div>
        <Suspense fallback={<Loading />}>
          <OverviewOffers query={query} />
        </Suspense>
        <Suspense fallback={<Loading />}>
          <OverviewOperations query={query} />
        </Suspense>
      </div>
    </PageFrame>
  );
}
