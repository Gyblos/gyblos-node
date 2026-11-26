import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { OfferPriceHistory } from '../../../components/offer-price-history';
import { PageFrame } from '../../../components/page-frame';
import { QueryRegion } from '../../../components/query-region';
import { SellerActivity } from '../../../components/seller-activity';
import { SellerProfileSection } from '../../../components/seller-profile';
import { SellerTxs } from '../../../components/seller-txs';
import { Loading } from '../../../components/ui';
import { ALL_TIME, PAGES, SELLER_STATUS } from '../../../lib/constants';
import { getDiscovery } from '../../../lib/discovery-render';
import { short } from '../../../lib/format';
import { getOfferPriceHistory } from '../../../lib/offer-price-history';
import { directoryHref, rangeOf, readQuery } from '../../../lib/paging';
import { sellerHref } from '../../../lib/seller-identity';
import { missingSellerHistory, sellerNodeId } from '../../../lib/seller-page';
import { sellerProfile, unknownSeller } from '../../../lib/seller-profile';
import { getSellerStats } from '../../../lib/seller-stats';
import { SITE } from '../../../lib/site';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ nodeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const nodeId = sellerNodeId((await params).nodeId);
  if (!nodeId) return {};
  const path = sellerHref(nodeId);
  const snapshot = await getDiscovery();
  const known =
    !snapshot.error &&
    sellerProfile(nodeId, snapshot).status !== SELLER_STATUS.unknown;
  const title = `Seller ${short(nodeId)} · ${SITE.name}`;
  const description = `Status, uptime, models, prices, daily requests and channel transactions of the Gyblos seller ${nodeId}.`;
  return {
    title,
    description,
    alternates: { canonical: path },
    ...(known ? {} : { robots: { index: false, follow: true } }),
    openGraph: { type: 'website', url: path, title, description },
    twitter: { title, description },
  };
}

export default async function SellerPage({ params, searchParams }: Props) {
  const nodeId = sellerNodeId((await params).nodeId);
  if (!nodeId) notFound();
  const query = readQuery(await searchParams, sellerHref(nodeId));
  const days = rangeOf(query, 'activity');
  const [snapshot, stats, history] = await Promise.all([
    getDiscovery(),
    getSellerStats(nodeId, ALL_TIME),
    getOfferPriceHistory({ nodeId, days, closed: query.closed }),
  ]);
  if (
    unknownSeller(nodeId, snapshot, stats) &&
    (await missingSellerHistory(history, days, () =>
      getOfferPriceHistory({ nodeId, days: ALL_TIME }),
    ))
  )
    notFound();
  return (
    <PageFrame
      title={`Seller ${short(nodeId)}`}
      crumb={`Seller ${short(nodeId)}`}
    >
      <Suspense fallback={<Loading />}>
        <SellerProfileSection
          nodeId={nodeId}
          directory={
            <Link
              className="hover:text-ink hover:underline"
              href={directoryHref(PAGES.sellers, query, 'activity')}
            >
              All sellers →
            </Link>
          }
        />
      </Suspense>
      <QueryRegion>
        <Suspense fallback={<Loading cards />}>
          <SellerActivity nodeId={nodeId} query={query} />
        </Suspense>
        <OfferPriceHistory history={history} />
      </QueryRegion>
      <Suspense fallback={<Loading />}>
        <SellerTxs nodeId={nodeId} query={query} />
      </Suspense>
    </PageFrame>
  );
}
