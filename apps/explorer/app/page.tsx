import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { Overview } from '../components/overview';
import {
  OverviewOffers,
  OverviewOperations,
} from '../components/overview-evidence';
import { PageFrame } from '../components/page-frame';
import { Loading } from '../components/ui';
import {
  canonicalPageHref,
  movedHomeHref,
  rangeOf,
  readQuery,
} from '../lib/paging';

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
  const query = readQuery(params);
  return (
    <PageFrame overview title="Gyblos Explorer">
      <Suspense
        key={`overview-${rangeOf(query, 'overview')}`}
        fallback={<Loading overview />}
      >
        <Overview query={query} />
      </Suspense>
      <div className="ov-evidence">
        <Suspense fallback={<Loading />}>
          <OverviewOffers query={query} />
        </Suspense>
        <Suspense fallback={<Loading />}>
          <OverviewOperations />
        </Suspense>
      </div>
    </PageFrame>
  );
}
