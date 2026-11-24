import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { PageFrame } from '../../../components/page-frame';
import { SellerActivity } from '../../../components/seller-activity';
import { SellerProfileSection } from '../../../components/seller-profile';
import { SellerTxs } from '../../../components/seller-txs';
import { Loading } from '../../../components/ui';
import { ALL_TIME, SELLER_STATUS } from '../../../lib/constants';
import { getDiscovery } from '../../../lib/discovery-render';
import { short } from '../../../lib/format';
import { rangeOf, readQuery } from '../../../lib/paging';
import { sellerHref } from '../../../lib/seller-identity';
import { sellerNodeId } from '../../../lib/seller-page';
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
  const [snapshot, stats] = await Promise.all([
    getDiscovery(),
    getSellerStats(nodeId, ALL_TIME),
  ]);
  if (unknownSeller(nodeId, snapshot, stats)) notFound();
  return (
    <PageFrame
      title={`Gyblos seller ${nodeId}`}
      crumb={`Seller ${short(nodeId)}`}
    >
      <Suspense fallback={<Loading />}>
        <SellerProfileSection nodeId={nodeId} />
      </Suspense>
      <Suspense
        key={`activity-${rangeOf(query, 'activity')}`}
        fallback={<Loading cards />}
      >
        <SellerActivity nodeId={nodeId} query={query} />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <SellerTxs nodeId={nodeId} query={query} />
      </Suspense>
    </PageFrame>
  );
}
