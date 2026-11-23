import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { LiveRefresh } from '../../../components/live-refresh';
import { NetworkSelect } from '../../../components/network-select';
import { RangeControl } from '../../../components/range-control';
import { SellerActivity } from '../../../components/seller-activity';
import { SellerProfileSection } from '../../../components/seller-profile';
import { SellerTxs } from '../../../components/seller-txs';
import { Loading } from '../../../components/ui';
import { txPageHref } from '../../../lib/chain-txs-shape';
import { SELLER_PAGE } from '../../../lib/constants';
import { short } from '../../../lib/format';
import { sellerNodeId, sellerPageState } from '../../../lib/seller-page';
import { SITE } from '../../../lib/site';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ nodeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const nodeId = sellerNodeId((await params).nodeId);
  if (!nodeId) return {};
  const path = `${SELLER_PAGE.path}/${nodeId}`;
  const title = `Seller ${short(nodeId)} · ${SITE.name}`;
  const description = `Status, uptime, models, prices, daily requests and channel transactions of the Gyblos seller ${nodeId}.`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', url: path, title, description },
    twitter: { title, description },
  };
}

export default async function SellerPage({ params, searchParams }: Props) {
  const nodeId = sellerNodeId((await params).nodeId);
  if (!nodeId) notFound();
  const state = sellerPageState(await searchParams);
  const home = txPageHref(state.days, null);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-5">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1"
        >
          <Link
            href={home}
            className="text-xl font-medium tracking-tight hover:text-brand"
          >
            gyblos
          </Link>
          <Link href={home} className="text-muted hover:text-brand">
            Explorer
          </Link>
          <span aria-hidden className="text-dim">
            /
          </span>
          <span aria-current="page" className="font-mono text-sm text-muted">
            Seller {short(nodeId)}
          </span>
        </nav>
        <div className="flex items-center gap-2">
          <LiveRefresh />
          <RangeControl days={state.days} />
          <NetworkSelect />
        </div>
      </header>
      <Suspense fallback={<Loading />}>
        <SellerProfileSection nodeId={nodeId} />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <SellerActivity nodeId={nodeId} state={state} />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <SellerTxs nodeId={nodeId} state={state} />
      </Suspense>
    </div>
  );
}
