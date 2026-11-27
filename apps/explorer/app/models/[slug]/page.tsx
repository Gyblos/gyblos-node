import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ModelActivity } from '../../../components/model-activity';
import { ModelHero, ModelTitle } from '../../../components/model-hero';
import { ModelPrices } from '../../../components/model-prices';
import { OfferPriceHistory } from '../../../components/offer-price-history';
import { PageFrame } from '../../../components/page-frame';
import { pagedRows, Pager } from '../../../components/pager';
import { SellerCell } from '../../../components/seller-cell';
import {
  Addr,
  EmptyRow,
  moneyCell,
  numberCell,
  prefixedColumn,
  SectionTitle,
  Table,
  td,
  Unavailable,
} from '../../../components/ui';
import { getCollector } from '../../../lib/collector';
import { ALL_TIME, DISPLAY, PAGES, PAGING } from '../../../lib/constants';
import type {
  DiscoverySnapshot,
  OfferedModel,
  Seller,
} from '../../../lib/discovery';
import { getDiscovery } from '../../../lib/discovery-render';
import { count, percent, pricePerMtok, utc } from '../../../lib/format';
import { modelView } from '../../../lib/model-catalog';
import { modelNow } from '../../../lib/model-page';
import {
  getOfferPriceHistory,
  type OfferPriceHistory as PriceHistory,
} from '../../../lib/offer-price-history';
import {
  modelFromSlug,
  modelHref,
  modelKey,
  uptimeRatio,
} from '../../../lib/offers';
import {
  directoryHref,
  rangeOf,
  readQuery,
  tablePager,
  type ExplorerQuery,
} from '../../../lib/paging';
import { displayRange } from '../../../lib/range';
import {
  githubByNode,
  namesByNode,
  sellerHref,
} from '../../../lib/seller-identity';
import { SITE } from '../../../lib/site';

export const dynamic = 'force-dynamic';
type Params = Promise<{ slug: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const model = modelFromSlug((await params).slug);
  if (!model) return {};
  const path = modelHref(model);
  const title = `${model.modelId} · ${SITE.name}`;
  const description = `Sellers, prices, requests, latency and unserved demand of ${model.modelId} on the Gyblos network.`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', url: path, title, description },
    twitter: { title, description },
  };
}

interface Offer {
  seller: Seller;
  offer: OfferedModel;
}
const OFFER_HEAD = [
  prefixedColumn('Seller', 'seller'),
  { label: 'Context', right: true, sort: 'context' },
  { label: 'Uptime 7 d', right: true, sort: 'uptimeWeek' },
  {
    label: 'Input / 1M',
    right: true,
    group: 'USDC',
    sort: 'input',
    ascendingFirst: true,
  },
  {
    label: 'Output / 1M',
    right: true,
    group: 'USDC',
    sort: 'output',
    ascendingFirst: true,
  },
];
const weekUptime = (seller: Seller) => uptimeRatio(seller, DISPLAY.weekWindow);

function OffersTable({
  discovery,
  offers,
  query,
}: {
  discovery: DiscoverySnapshot;
  offers: Offer[];
  query: ExplorerQuery;
}) {
  const days = rangeOf(query, 'models');
  const accounts = githubByNode(discovery.network);
  const names = namesByNode(discovery.network);
  const page = pagedRows(query, 'sellers', offers, !discovery.error, {
    context: ({ offer }) => offer.contextTokens,
    uptimeWeek: ({ seller }) => weekUptime(seller),
    input: ({ offer }) => BigInt(offer.pricing.inputAtomicPerMtok),
    output: ({ offer }) => BigInt(offer.pricing.outputAtomicPerMtok),
  });
  return (
    <>
      <SectionTitle
        id="sellers"
        title="Current offers"
        meta={`As of ${utc(discovery.datedAt ?? discovery.generatedAt)}`}
      />
      <Table
        minWidth={DISPLAY.defaultTable}
        sorting={{ query, table: 'sellers' }}
        head={OFFER_HEAD}
        footer={
          <Pager
            label="Current offers"
            view={tablePager(query, 'sellers', page)}
          />
        }
      >
        {page.rows.map(({ seller, offer }) => {
          const uptime = weekUptime(seller);
          return (
            <tr key={seller.nodeId} className="border-t border-line">
              <td className={td}>
                <SellerCell
                  nodeId={seller.nodeId}
                  name={names.get(seller.nodeId)}
                  github={accounts.get(seller.nodeId) ?? null}
                  href={sellerHref(seller.nodeId, { ...query, days })}
                >
                  <Addr value={seller.owner} />
                </SellerCell>
              </td>
              <td className={numberCell}>{count(offer.contextTokens)}</td>
              <td className={numberCell}>
                {uptime === undefined ? '—' : percent(uptime)}
              </td>
              <td className={moneyCell}>
                {pricePerMtok(offer.pricing.inputAtomicPerMtok)}
              </td>
              <td className={moneyCell}>
                {pricePerMtok(offer.pricing.outputAtomicPerMtok)}
              </td>
            </tr>
          );
        })}
        {!offers.length && (
          <EmptyRow columns={OFFER_HEAD.length}>
            No current offers for this variant.
          </EmptyRow>
        )}
      </Table>
    </>
  );
}

function sellerIdentities(discovery: DiscoverySnapshot, history: PriceHistory) {
  const nodeIds = history.series.map((item) => item.nodeId);
  const accounts = githubByNode(discovery.network);
  const names = namesByNode(discovery.network);
  return Object.fromEntries(
    nodeIds.map((nodeId) => [
      nodeId,
      {
        name: names.get(nodeId) ?? null,
        github: accounts.get(nodeId) ?? null,
      },
    ]),
  );
}

function otherVariants(
  model: {
    modelId: string;
    variant: string | null;
    quantization: string | null;
  },
  listed: {
    modelId: string;
    variant: string | null;
    quantization: string | null;
  }[],
) {
  const key = modelKey(model);
  const variants = new Map(
    listed
      .filter(
        (item) => item.modelId === model.modelId && modelKey(item) !== key,
      )
      .map((item) => [modelKey(item), item]),
  );
  return [...variants.values()];
}

export default async function ModelPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const model = modelFromSlug((await params).slug);
  if (!model) notFound();
  const query = readQuery(await searchParams, modelHref(model));
  const days = rangeOf(query, 'models');
  const [discovery, collector, earlier, history] = await Promise.all([
    getDiscovery(),
    getCollector(days, 0, query.closed),
    days === ALL_TIME ? null : getCollector(days, 1, query.closed),
    getOfferPriceHistory({ model, days, closed: query.closed }),
  ]);
  const key = modelKey(model);
  const view = modelView(discovery.models, model.modelId);
  const offers = discovery.sellers.flatMap((seller) =>
    seller.models
      .filter((offer) => modelKey(offer) === key)
      .map((offer) => ({ seller, offer })),
  );
  const stat = collector.models.find((item) => modelKey(item) === key);
  const previous =
    !earlier || earlier.error
      ? null
      : earlier.models.find((item) => modelKey(item) === key);
  return (
    <PageFrame
      title={<ModelTitle modelId={model.modelId} view={view} />}
      crumb="Model"
    >
      <ModelHero
        model={model}
        view={view}
        now={modelNow(offers)}
        known={!discovery.error}
        variants={otherVariants(model, [
          ...discovery.sellers.flatMap((seller) => seller.models),
          ...collector.models,
        ])}
        directory={directoryHref(PAGES.models, query, 'models')}
        days={days}
        closed={query.closed}
      />
      <SectionTitle
        id={PAGING.anchors.models}
        title={`Activity, ${displayRange(days)}`}
        meta={query.closed ? 'Completed UTC days' : undefined}
        range={{ section: 'models', days }}
      />
      {collector.error ? (
        <p className="text-sm text-muted">
          The metrics collector did not answer for this period.
        </p>
      ) : (
        <ModelActivity
          stat={stat}
          previous={previous}
          days={collector.days}
          modelId={model.modelId}
        />
      )}
      {discovery.error ? (
        <Unavailable title="Current offers" />
      ) : (
        <OffersTable discovery={discovery} offers={offers} query={query} />
      )}
      <OfferPriceHistory
        history={history}
        bySeller
        sellers={sellerIdentities(discovery, history)}
        overview={<ModelPrices history={history} />}
      />
    </PageFrame>
  );
}
