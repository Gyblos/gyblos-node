// Owns the explorer's single page: the network, usage and payments sections, each streamed on its own
// so a slow source never blocks the others.
import { Suspense } from 'react';

import { NetworkSection } from '../components/network-section';
import { PaymentsSection } from '../components/payments-section';
import { Loading } from '../components/ui';
import { UsageSection } from '../components/usage-section';
import { NETWORK_LABEL } from '../lib/config';

// Every request renders with fresh source answers; the sources cache at their own edge (the collector
// for 5 minutes). Workers cannot share a pending fetch across requests, so no in-process cache is used.
export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between gap-4 border-b border-line py-5">
        <div className="flex items-baseline gap-3">
          <span className="text-xl font-medium tracking-tight">gyblos</span>
          <span className="text-muted">Explorer</span>
        </div>
        <span className="rounded-full border border-line px-3 py-1 font-mono text-xs text-muted">
          {NETWORK_LABEL}
        </span>
      </header>
      <Suspense fallback={<Loading />}>
        <NetworkSection />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <UsageSection />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <PaymentsSection />
      </Suspense>
    </div>
  );
}
