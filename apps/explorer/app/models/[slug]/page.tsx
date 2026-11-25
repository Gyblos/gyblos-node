import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ModelLogo } from '../../../components/model-logo';
import { OfferPriceHistory } from '../../../components/offer-price-history';
import { PageFrame } from '../../../components/page-frame';
import { pagedRows, Pager } from '../../../components/pager';
import { SellerCell } from '../../../components/seller-cell';
import {
  Addr,
  EmptyRow,
  ModelName,
  moneyCell,
  numberCell,
  prefixedColumn,
  SectionTitle,
  Table,
  td,
  Unavailable,
} from '../../../components/ui';
import { getCollector } from '../../../lib/collector';
import type { ModelSide, ModelStat } from '../../../lib/collector-shape';
import { DISPLAY, PAGES, PAGING } from '../../../lib/constants';
import type {
  DiscoverySnapshot,
  OfferedModel,
  Seller,
} from '../../../lib/discovery';
import { getDiscovery } from '../../../lib/discovery-render';
import {
  count,
  latencyMs,
  percent,
  pricePerMtok,
  tokensPerSecond,
  usdcFixed,
  utc,
} from '../../../lib/format';
import { mergedLatency } from '../../../lib/latency';
import { modelLab } from '../../../lib/model-family';
import { getOfferPriceHistory } from '../../../lib/offer-price-history';
import { modelFromSlug, modelHref, modelKey } from '../../../lib/offers';
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

export const dynamic = 'force-dynamic';
type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const model = modelFromSlug((await params).slug);
  return model ? { title: `${model.modelId} · Gyblos Explorer` } : {};
}

function sampled(value: string, samples: number | undefined) {
  if (!samples) return '—';
  return `${value} · ${count(samples)} ${samples === 1 ? 'sample' : 'samples'}`;
}

const measures: { label: string; value: (side: ModelSide) => string }[] = [
  {
    label: 'Recorded requests',
    value: (side) => count(side.requests.headline),
  },
  { label: 'Completed', value: (side) => count(side.outcomes.completed) },
  { label: 'Failed', value: (side) => count(side.outcomes.failed) },
  { label: 'Cancelled', value: (side) => count(side.outcomes.cancelled) },
  {
    label: 'Success rate',
    value: (side) =>
      side.successRate === null ? '—' : percent(side.successRate),
  },
  { label: 'Input tokens', value: (side) => count(side.tokens.input) },
  { label: 'Output tokens', value: (side) => count(side.tokens.output) },
  {
    label: 'Bilateral receipts',
    value: (side) => count(side.requests.bilateral),
  },
  {
    label: 'Seller-only receipts',
    value: (side) => count(side.requests.sellerOnly),
  },
  {
    label: 'Disputed receipts',
    value: (side) => count(side.requests.disputed),
  },
  {
    label: 'Authorized USDC',
    value: (side) =>
      side.authorizedAtomic === null
        ? '—'
        : usdcFixed(BigInt(side.authorizedAtomic)),
  },
  {
    label: 'Seller first token p50',
    value: (side) =>
      sampled(
        latencyMs(
          mergedLatency([side.sellerLatency.firstToken], DISPLAY.median),
        ),
        side.sellerLatency.firstToken.samples,
      ),
  },
  {
    label: 'Buyer first token p50',
    value: (side) =>
      sampled(
        latencyMs(
          mergedLatency([side.observed?.buyerFirstToken], DISPLAY.median),
        ),
        side.observed?.buyerFirstToken.samples,
      ),
  },
  {
    label: 'Engine speed p50',
    value: (side) =>
      sampled(
        tokensPerSecond(
          side.observed?.engineSpeed.p50MinTokensPerSecond ?? null,
        ),
        side.observed?.engineSpeed.samples,
      ),
  },
];

function ActivityTable({
  stat,
  query,
}: {
  stat: ModelStat | undefined;
  query: ExplorerQuery;
}) {
  const page = pagedRows(query, 'models', stat ? measures : []);
  return (
    <Table
      minWidth={320}
      footer={
        <Pager
          label="Activity metrics"
          view={tablePager(query, 'models', page)}
        />
      }
      head={[
        { label: 'Metric' },
        { label: 'Free', right: true },
        { label: 'Paid', right: true },
      ]}
    >
      {!stat && (
        <EmptyRow columns={3}>
          No published aggregate for this variant in the selected period.
        </EmptyRow>
      )}
      {page.rows.map(({ label, value }) => (
        <tr key={label} className="border-t border-line">
          <td className={td}>{label}</td>
          <td className={numberCell}>{stat?.free ? value(stat.free) : '—'}</td>
          <td className={numberCell}>{stat?.paid ? value(stat.paid) : '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

const OFFER_HEAD = [
  prefixedColumn('Seller', 'seller'),
  { label: 'Context', right: true, sort: 'context' },
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

function OffersTable({
  discovery,
  offers,
  query,
}: {
  discovery: DiscoverySnapshot;
  offers: { seller: Seller; offer: OfferedModel }[];
  query: ExplorerQuery;
}) {
  const days = rangeOf(query, 'models');
  const accounts = githubByNode(discovery.network);
  const names = namesByNode(discovery.network);
  const page = pagedRows(query, 'sellers', offers, !discovery.error, {
    context: ({ offer }) => offer.contextTokens,
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
        minWidth={560}
        sorting={{ query, table: 'sellers' }}
        head={OFFER_HEAD}
        footer={
          <Pager
            label="Current offers"
            view={tablePager(query, 'sellers', page)}
          />
        }
      >
        {page.rows.map(({ seller, offer }) => (
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
            <td className={moneyCell}>
              {pricePerMtok(offer.pricing.inputAtomicPerMtok)}
            </td>
            <td className={moneyCell}>
              {pricePerMtok(offer.pricing.outputAtomicPerMtok)}
            </td>
          </tr>
        ))}
        {!offers.length && (
          <EmptyRow columns={4}>No current offers for this variant.</EmptyRow>
        )}
      </Table>
    </>
  );
}

function ModelHeading({
  model,
}: {
  model: NonNullable<ReturnType<typeof modelFromSlug>>;
}) {
  return (
    <span className="flex items-center gap-3">
      <ModelLogo modelId={model.modelId} />
      <span className="min-w-0">
        <span className="block text-sm text-muted">
          {modelLab(model.modelId) ?? 'Lab unknown'}
        </span>
        <span className="block break-all">{model.modelId}</span>
        <span className="block font-mono text-sm text-muted">
          {[model.variant, model.quantization].filter(Boolean).join(' · ')}
        </span>
      </span>
    </span>
  );
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
  const [discovery, collector, history] = await Promise.all([
    getDiscovery(),
    getCollector(days, 0, query.closed),
    getOfferPriceHistory({ model, days, closed: query.closed }),
  ]);
  const key = modelKey(model);
  const offers = discovery.sellers.flatMap((seller) =>
    seller.models
      .filter((offer) => modelKey(offer) === key)
      .map((offer) => ({ seller, offer })),
  );
  const stat = collector.models.find((stat) => modelKey(stat) === key);
  const siblings = new Map(
    [
      ...discovery.sellers.flatMap((seller) => seller.models),
      ...collector.models,
    ]
      .filter(
        (item) => item.modelId === model.modelId && modelKey(item) !== key,
      )
      .map((item) => [modelKey(item), item]),
  );
  return (
    <PageFrame title={<ModelHeading model={model} />} crumb="Model">
      <Link
        className="mt-2 inline-block text-sm text-muted hover:text-ink hover:underline"
        href={directoryHref(PAGES.models, query, 'models')}
      >
        All models →
      </Link>
      {discovery.error ? (
        <Unavailable title="Current offers" />
      ) : (
        <OffersTable discovery={discovery} offers={offers} query={query} />
      )}
      <OfferPriceHistory history={history} bySeller />
      <SectionTitle
        id={PAGING.anchors.models}
        title={`Recorded activity, ${displayRange(days)}`}
        meta={query.closed ? 'Completed UTC days' : undefined}
        range={{ section: 'models', days }}
      />
      {collector.error ? (
        <p className="text-sm text-muted">Metrics collector unavailable.</p>
      ) : (
        <ActivityTable stat={stat} query={query} />
      )}
      {siblings.size > 0 && (
        <>
          <SectionTitle title="Other variants" />
          <ul className="grid gap-2">
            {Array.from(siblings, ([id, sibling]) => (
              <li key={id}>
                <ModelName {...sibling} days={days} closed={query.closed} />
              </li>
            ))}
          </ul>
        </>
      )}
    </PageFrame>
  );
}
