import {
  Boxes,
  CircleCheck,
  Hash,
  MessagesSquare,
  Timer,
  Wallet,
} from 'lucide-react';

import type { SellerDay } from '../lib/collector-shape';
import { DISPLAY, PAGING } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { count, pricePerMtok, usdcDecimal } from '../lib/format';
import { tablePager, type ExplorerQuery } from '../lib/paging';
import {
  sellerModelRows,
  sellerProfile,
  sellerTotals,
} from '../lib/seller-profile';
import { getSellerStats } from '../lib/seller-stats';
import {
  buyersText,
  countText,
  dailyRequests,
  latencyText,
  pair,
  rateText,
  sideFigures,
  usageMeta,
} from '../lib/usage';
import { Flow, FlowPair } from './board/animated-number';
import { BarChartCard } from './board/bar-chart-card';
import { StatCard } from './board/stat-card';
import { pagedRows, Pager } from './pager';
import {
  ModelName,
  moneyCell,
  numberCell,
  SectionTitle,
  Table,
  td,
  Unavailable,
} from './ui';

type Section = Parameters<typeof sideFigures>[0][number];
type Figure = 'requests' | 'successRate' | 'outputTokens' | 'firstToken';
const muted = `${td} text-muted`;
function pairText(free: Section, paid: Section, figure: Figure) {
  const left = sideFigures([free]);
  const right = sideFigures([paid]);
  if (figure === 'successRate')
    return pair(left.successRate, right.successRate, rateText);
  if (figure === 'firstToken')
    return pair(left.firstToken, right.firstToken, latencyText);
  return pair(left[figure], right[figure], countText);
}

function RequestCharts({ days }: { days: SellerDay[] }) {
  const series = dailyRequests(days);
  const chart = (side: 'free' | 'paid') =>
    series.map((day) => ({
      day: day.day,
      value: day[side],
      amount: day[side],
    }));
  const total = (side: 'free' | 'paid') =>
    series.reduce((sum, day) => sum + day[side], 0);
  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <BarChartCard
        title="Free requests per day"
        kind="count"
        total={total('free')}
        points={chart('free')}
      />
      <BarChartCard
        title="Paid requests per day"
        kind="count"
        total={total('paid')}
        points={chart('paid')}
      />
    </div>
  );
}

function ModelsTable({
  query,
  rows,
  served,
}: {
  query: ExplorerQuery;
  rows: ReturnType<typeof sellerModelRows>;
  served: boolean;
}) {
  const head = [
    { label: 'Model' },
    { label: 'Context', right: true },
    { label: 'Input / 1M', right: true },
    { label: 'Output / 1M', right: true },
    { label: 'Requests free · paid', right: true },
    { label: 'Success free · paid', right: true },
    { label: 'Seller first token p50 free · paid', right: true },
  ];
  const shown = pagedRows(query, 'models', rows);
  const figure = (row: (typeof rows)[number], name: Figure) =>
    served ? pairText(row.free, row.paid, name) : '—';
  return (
    <>
      <SectionTitle id={PAGING.anchors.models} title="Models" />
      <p className="-mt-2 mb-3 text-xs text-muted">
        Context and prices are the seller&apos;s current offer; requests are
        over the range{served ? '' : ' (unavailable now)'}. A model without a
        price is not offered now.
      </p>
      <Table minWidth={DISPLAY.modelsTable} head={head}>
        {rows.length ? null : (
          <tr>
            <td className={muted} colSpan={head.length}>
              No models offered now or served in this range.
            </td>
          </tr>
        )}
        {shown.rows.map((row) => (
          <tr key={row.key} className="border-t border-line">
            <td className={td}>
              <ModelName
                modelId={row.modelId}
                variant={row.variant}
                quantization={row.quantization}
              />
            </td>
            <td className={numberCell}>
              {row.offer ? count(row.offer.contextTokens) : '—'}
            </td>
            <td className={row.offer ? moneyCell : numberCell}>
              {row.offer
                ? pricePerMtok(row.offer.pricing.inputAtomicPerMtok)
                : '—'}
            </td>
            <td className={row.offer ? moneyCell : numberCell}>
              {row.offer
                ? pricePerMtok(row.offer.pricing.outputAtomicPerMtok)
                : '—'}
            </td>
            <td className={numberCell}>{figure(row, 'requests')}</td>
            <td className={numberCell}>{figure(row, 'successRate')}</td>
            <td className={numberCell}>{figure(row, 'firstToken')}</td>
          </tr>
        ))}
      </Table>
      <Pager label="Models" view={tablePager(query, 'models', shown)} />
    </>
  );
}

function DailyTable({
  query,
  days,
}: {
  query: ExplorerQuery;
  days: SellerDay[];
}) {
  const head = [
    { label: 'Day (UTC)' },
    { label: 'Requests free · paid', right: true },
    { label: 'Success free · paid', right: true },
    { label: 'Output tokens free · paid', right: true },
    { label: 'Buyers free · paid', right: true },
  ];
  const active = [...days].reverse();
  const shown = pagedRows(query, 'daily', active);
  return (
    <>
      <SectionTitle id={PAGING.anchors.daily} title="Daily" />
      <Table minWidth={DISPLAY.dailyTable} head={head}>
        {active.length ? null : (
          <tr>
            <td className={muted} colSpan={head.length}>
              No daily activity in this range.
            </td>
          </tr>
        )}
        {shown.rows.map((day) => (
          <tr key={day.day} className="border-t border-line">
            <td className={`${td} font-mono`}>{day.day}</td>
            <td className={numberCell}>
              {pairText(day.free, day.paid, 'requests')}
            </td>
            <td className={numberCell}>
              {pairText(day.free, day.paid, 'successRate')}
            </td>
            <td className={numberCell}>
              {pairText(day.free, day.paid, 'outputTokens')}
            </td>
            <td className={numberCell}>
              {buyersText(day.free)} · {buyersText(day.paid)}
            </td>
          </tr>
        ))}
      </Table>
      <Pager label="Daily" view={tablePager(query, 'daily', shown)} />
      <p className="mt-2 text-xs text-dim">
        Buyers are distinct per day and side, never added up; counts below{' '}
        {DISPLAY.minPublicBuyers} are withheld and shown as &lt;{' '}
        {DISPLAY.minPublicBuyers}.
      </p>
    </>
  );
}

function Figures({
  totals,
  served,
}: {
  totals: ReturnType<typeof sellerTotals>;
  served: number;
}) {
  const { free, paid } = totals;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <StatCard
        icon={MessagesSquare}
        label="Requests free · paid"
        value={
          <FlowPair free={free.requests} paid={paid.requests} kind="count" />
        }
      />
      <StatCard
        icon={CircleCheck}
        label="Success free · paid"
        value={
          <FlowPair
            free={free.successRate}
            paid={paid.successRate}
            kind="percent"
          />
        }
        caption="Cancellations are not counted as failures"
      />
      <StatCard
        icon={Hash}
        label="Output tokens free · paid"
        value={
          <FlowPair
            free={free.outputTokens}
            paid={paid.outputTokens}
            kind="count"
          />
        }
      />
      <StatCard
        icon={Timer}
        label="Seller first token p50 free · paid"
        value={pair(free.firstToken, paid.firstToken, latencyText)}
      />
      <StatCard
        icon={Wallet}
        label="Authorized (paid)"
        value={<Flow value={usdcDecimal(totals.authorized)} kind="usdc" />}
        caption="Usage both sides signed for, not settled USDC"
        money
      />
      <StatCard
        icon={Boxes}
        label="Models served"
        value={<Flow value={served} kind="count" />}
        caption="Models with requests in the range"
      />
    </div>
  );
}

export async function SellerActivity({
  nodeId,
  query,
}: {
  nodeId: string;
  query: ExplorerQuery;
}) {
  const [stats, snapshot] = await Promise.all([
    getSellerStats(nodeId, query.days),
    getDiscovery(),
  ]);
  const offers = snapshot.error ? [] : sellerProfile(nodeId, snapshot).offers;
  const totals = sellerTotals(stats.days);
  return (
    <>
      {stats.error ? (
        <Unavailable
          title={`Activity · ${query.days} days`}
          anchors={[PAGING.anchors.daily]}
        />
      ) : (
        <>
          <SectionTitle
            title={`Activity · ${query.days} days`}
            meta={usageMeta(query.days, stats.aggregatedAt, false)}
          />
          <Figures totals={totals} served={stats.models.length} />
          <p className="mt-2 text-xs text-dim">
            No earned total is shown: there is no per-seller on-chain total yet.
            Payouts are listed per transaction below.
          </p>
          <RequestCharts days={stats.days} />
        </>
      )}
      <ModelsTable
        query={query}
        rows={sellerModelRows(offers, stats.models)}
        served={!stats.error}
      />
      {stats.error ? null : <DailyTable query={query} days={totals.active} />}
    </>
  );
}
