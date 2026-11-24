import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { ChannelTxs } from '../../components/channel-txs';
import { PageFrame } from '../../components/page-frame';
import { Loading } from '../../components/ui';
import { PAGES } from '../../lib/constants';
import { pageMetadata } from '../../lib/page-meta';
import { canonicalPageHref, readQuery } from '../../lib/paging';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata(
  'Transactions',
  PAGES.transactions,
  'Every Gyblos payment channel transaction on Solana devnet, newest first: deposits, settlements, payouts with their split, and refunds.',
);

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const canonical = canonicalPageHref(params, PAGES.transactions);
  if (canonical) redirect(canonical);
  const query = readQuery(params, PAGES.transactions);
  return (
    <PageFrame title="Gyblos channel transactions">
      <Suspense fallback={<Loading />}>
        <ChannelTxs query={query} />
      </Suspense>
    </PageFrame>
  );
}
