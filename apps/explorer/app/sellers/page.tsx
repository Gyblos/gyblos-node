import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { NetworkSection } from '../../components/network-section';
import { PageFrame } from '../../components/page-frame';
import { Loading } from '../../components/ui';
import { PAGES } from '../../lib/constants';
import { pageMetadata } from '../../lib/page-meta';
import { canonicalPageHref, readQuery } from '../../lib/paging';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata(
  'Sellers',
  PAGES.sellers,
  'Every Gyblos seller: who is online now, the models and prices they offer, their uptime and GitHub verification, and who is offline or not published.',
);

export default async function SellersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const canonical = canonicalPageHref(params, PAGES.sellers);
  if (canonical) redirect(canonical);
  const query = readQuery(params, PAGES.sellers);
  return (
    <PageFrame title="Gyblos sellers">
      <Suspense fallback={<Loading />}>
        <NetworkSection query={query} />
      </Suspense>
    </PageFrame>
  );
}
