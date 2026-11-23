import { CircleCheck, Hash, MessagesSquare } from 'lucide-react';

import type { SellerDay } from '../lib/collector-shape';
import { DISPLAY } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { count, pricePerMtok } from '../lib/format';
import { pageOf, sellerHref, type SellerPageState } from '../lib/seller-page';
import { sellerModelRows, sellerProfile } from '../lib/seller-profile';
import { getSellerStats } from '../lib/seller-stats';
import {
  buyersText,
  countText,
  dailyRequests,
  pair,
  rateText,
  sideFigures,
  usageMeta,
} from '../lib/usage';
import { FlowPair } from './board/animated-number';
import { BarChartCard } from './board/bar-chart-card';
import { StatCard } from './board/stat-card';
import { PageLinks } from './page-links';
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
const muted = `${td} text-muted`;
const requestsText = (free: Section, paid: Section) =>
  pair(sideFigures([free]).requests, sideFigures([paid]).requests, countText);
const successText = (free: Section, paid: Section) =>
  pair(
    sideFigures([free]).successRate,
    sideFigures([paid]).successRate,
    rateText,
  );

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
  nodeId,
  state,
  rows,
  offersKnown,
}: {
  nodeId: string;
  state: SellerPageState;
  rows: ReturnType<typeof sellerModelRows>;
  offersKnown: boolean;
}) {
  const head = [
    { label: 'Model' },
    { label: 'Context', right: true },
    { label: 'Input / 1M', right: true },
    { label: 'Output / 1M', right: true },
    { label: 'Requests free · paid', right: true },
    { label: 'Success free · paid', right: true },
  ];
  const shown = pageOf(rows, state.models);
  const href = (page: number) => sellerHref(nodeId, { ...state, models: page });
  return (
    <>
      <SectionTitle
        title="Models"
        meta={offersKnown ? undefined : 'current offers unavailable'}
      />
      <p className="-mt-2 mb-3 text-xs text-muted">
        Context and prices are the seller&apos;s current offer; requests are
        over the range. A model without a price is not offered now.
      </p>
      <Table minWidth={DISPLAY.wideTable} head={head}>
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
            <td className={numberCell}>{requestsText(row.free, row.paid)}</td>
            <td className={numberCell}>{successText(row.free, row.paid)}</td>
          </tr>
        ))}
      </Table>
      <PageLinks page={shown.page} pages={shown.pages} href={href} />
    </>
  );
}

function DailyTable({
  nodeId,
  state,
  days,
}: {
  nodeId: string;
  state: SellerPageState;
  days: SellerDay[];
}) {
  const head = [
    { label: 'Day (UTC)' },
    { label: 'Requests free · paid', right: true },
    { label: 'Success free · paid', right: true },
    { label: 'Output tokens free · paid', right: true },
    { label: 'Buyers free · paid', right: true },
  ];
  const active = days.filter((day) => day.free || day.paid).reverse();
  const shown = pageOf(active, state.daily);
  const href = (page: number) => sellerHref(nodeId, { ...state, daily: page });
  return (
    <>
      <SectionTitle title="Daily" />
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
            <td className={numberCell}>{requestsText(day.free, day.paid)}</td>
            <td className={numberCell}>{successText(day.free, day.paid)}</td>
            <td className={numberCell}>
              {pair(
                sideFigures([day.free]).outputTokens,
                sideFigures([day.paid]).outputTokens,
                countText,
              )}
            </td>
            <td className={numberCell}>
              {buyersText(day.free)} · {buyersText(day.paid)}
            </td>
          </tr>
        ))}
      </Table>
      <PageLinks page={shown.page} pages={shown.pages} href={href} />
      <p className="mt-2 text-xs text-dim">
        Buyers are distinct per day and side, never added up; counts below{' '}
        {DISPLAY.minPublicBuyers} are withheld and shown as &lt;{' '}
        {DISPLAY.minPublicBuyers}.
      </p>
    </>
  );
}

export async function SellerActivity({
  nodeId,
  state,
}: {
  nodeId: string;
  state: SellerPageState;
}) {
  const [stats, snapshot] = await Promise.all([
    getSellerStats(nodeId, state.days),
    getDiscovery(),
  ]);
  if (stats.error) return <Unavailable title="Activity" />;
  const active = stats.days.filter((day) => day.free || day.paid);
  const free = sideFigures(active.map((day) => day.free));
  const paid = sideFigures(active.map((day) => day.paid));
  const offers = snapshot.error ? [] : sellerProfile(nodeId, snapshot).offers;
  return (
    <>
      <SectionTitle
        title={`Activity · ${state.days} days`}
        meta={usageMeta(state.days, stats.aggregatedAt, false)}
      />
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
      </div>
      <RequestCharts days={stats.days} />
      <ModelsTable
        nodeId={nodeId}
        state={state}
        rows={sellerModelRows(offers, stats.models)}
        offersKnown={!snapshot.error}
      />
      <DailyTable nodeId={nodeId} state={state} days={stats.days} />
    </>
  );
}
