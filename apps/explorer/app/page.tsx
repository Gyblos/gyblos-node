// Owns the explorer's single page: the network, usage and payments sections, each streamed on its own
// so a slow source never blocks the others. The `range` search parameter picks the days shown; a range
// switch keeps the sections mounted so their figures roll to the new values.
import { Suspense } from 'react';

import { NetworkSection } from '../components/network-section';
import { NetworkSelect } from '../components/network-select';
import { PaymentsSection } from '../components/payments-section';
import { RangeControl } from '../components/range-control';
import { Loading } from '../components/ui';
import { UsageSection } from '../components/usage-section';
import { RANGE } from '../lib/constants';
import { parseRange } from '../lib/range';

// Every request renders with fresh source answers; the sources cache at their own edge (the collector
// for 5 minutes). Workers cannot share a pending fetch across requests, so no in-process cache is used.
export const dynamic = 'force-dynamic';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const days = parseRange((await searchParams)[RANGE.param]);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-5">
        <div className="flex items-baseline gap-3">
          <span className="text-xl font-medium tracking-tight">gyblos</span>
          <span className="text-muted">Explorer</span>
        </div>
        <div className="flex items-center gap-2">
          <RangeControl days={days} />
          <NetworkSelect />
        </div>
      </header>
      <Suspense fallback={<Loading />}>
        <NetworkSection />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <UsageSection days={days} />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <PaymentsSection days={days} />
      </Suspense>
    </div>
  );
}
