import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { ChannelTxs } from '../components/channel-txs';
import { NetworkSection } from '../components/network-section';
import { Overview } from '../components/overview';
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
    <PageFrame title="Gyblos Explorer">
      <Suspense
        key={`overview-${rangeOf(query, 'overview')}`}
        fallback={<Loading overview />}
      >
        <Overview query={query} />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <NetworkSection query={query} preview />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <ChannelTxs query={{ ...query, before: null }} preview />
      </Suspense>
    </PageFrame>
  );
}
