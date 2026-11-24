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
import { rangeOf, tablePager, type ExplorerQuery } from '../lib/paging';
import {
  modelsNote,
  modelsServedText,
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
  rateText,
  sideFigures,
  usageMeta,
} from '../lib/usage';
import { Flow } from './board/animated-number';
import { BarChartCard } from './board/bar-chart-card';
import { StatCard } from './board/stat-card';
import { pagedRows, Pager } from './pager';
import {
  ModelName,
  moneyCell,
  numberCell,
  SectionTitle,
  SideCells,
  sideColumns,
  Table,
  td,
  Unavailable,
} from './ui';

type Section = Parameters<typeof sideFigures>[0][number];
type Figure = 'requests' | 'successRate' | 'outputTokens' | 'firstToken';
const muted = `${td} text-muted`;
const FIGURE_TEXT: Record<Figure, (value: never) => string> = {
  requests: countText,
  successRate: rateText,
  outputTokens: countText,
  firstToken: latencyText,
};
function FigureCells({
  free,
  paid,
  figure,
  served = true,
}: {
  free: Section;
  paid: Section;
  figure: Figure;
  served?: boolean;
}) {
  const show = FIGURE_TEXT[figure] as (value: unknown) => string;
  return (
    <SideCells
      free={served ? sideFigures([free])[figure] : null}
      paid={served ? sideFigures([paid])[figure] : null}
      show={(value) => (served ? show(value) : '—')}
    />
  );
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

const MODELS_HEAD = [
  { label: 'Model' },
  { label: 'Context', right: true },
  { label: 'Input / 1M', right: true },
  { label: 'Output / 1M', right: true },
  ...sideColumns('Requests'),
  ...sideColumns('Success'),
  ...sideColumns('Seller first token p50'),
];

function ModelsTable({
  query,
  rows,
  served,
  offersKnown,
}: {
  query: ExplorerQuery;
  rows: ReturnType<typeof sellerModelRows>;
  served: boolean;
  offersKnown: boolean;
}) {
  const shown = pagedRows(query, 'models', rows);
  const figure = (row: (typeof rows)[number], name: Figure) => (
    <FigureCells
      free={row.free}
      paid={row.paid}
      figure={name}
      served={served}
    />
  );
  return (
    <>
      <SectionTitle id={PAGING.anchors.models} title="Models" />
      <p className="-mt-2 mb-3 text-xs text-muted">
        {modelsNote(served, offersKnown)}
      </p>
      <Table
        minWidth={DISPLAY.modelsTable}
        head={MODELS_HEAD}
        footer={
          <Pager label="Models" view={tablePager(query, 'models', shown)} />
        }
      >
        {rows.length ? null : (
          <tr>
            <td className={muted} colSpan={MODELS_HEAD.length}>
              No models offered now or served in this range.
            </td>
          </tr>
        )}
        {shown.rows.map((row) => (
          <tr key={row.key} className="border-t border-line">
            <td className={td}>
              <ModelName
                days={rangeOf(query, 'activity')}
                closed={query.closed}
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
            {figure(row, 'requests')}
            {figure(row, 'successRate')}
            {figure(row, 'firstToken')}
          </tr>
        ))}
      </Table>
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
    ...sideColumns('Requests'),
    ...sideColumns('Success'),
    ...sideColumns('Output tokens'),
    ...sideColumns('Buyers'),
  ];
  const active = [...days].reverse();
  const shown = pagedRows(query, 'daily', active);
  return (
    <>
      <SectionTitle id={PAGING.anchors.daily} title="Daily" />
      <Table
        minWidth={DISPLAY.dailyTable}
        head={head}
        footer={
          <Pager label="Daily" view={tablePager(query, 'daily', shown)} />
        }
      >
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
            <FigureCells free={day.free} paid={day.paid} figure="requests" />
            <FigureCells free={day.free} paid={day.paid} figure="successRate" />
            <FigureCells
              free={day.free}
              paid={day.paid}
              figure="outputTokens"
            />
            <SideCells free={day.free} paid={day.paid} show={buyersText} />
          </tr>
        ))}
      </Table>
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
        label="Requests"
        sides={{
          free: <Flow value={free.requests} kind="count" />,
          paid: <Flow value={paid.requests} kind="count" />,
        }}
      />
      <StatCard
        icon={CircleCheck}
        label="Success"
        sides={{
          free: <Flow value={free.successRate} kind="percent" />,
          paid: <Flow value={paid.successRate} kind="percent" />,
        }}
        hint="Completed requests out of completed and failed ones. Cancellations are not counted as failures."
      />
      <StatCard
        icon={Hash}
        label="Output tokens"
        sides={{
          free: <Flow value={free.outputTokens} kind="count" />,
          paid: <Flow value={paid.outputTokens} kind="count" />,
        }}
      />
      <StatCard
        icon={Timer}
        label="Seller first token p50"
        sides={{
          free: latencyText(free.firstToken),
          paid: latencyText(paid.firstToken),
        }}
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
        value={modelsServedText(served)}
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
  const days = rangeOf(query, 'activity');
  const [stats, snapshot] = await Promise.all([
    getSellerStats(nodeId, days, query.closed),
    getDiscovery(),
  ]);
  const offers = snapshot.error ? [] : sellerProfile(nodeId, snapshot).offers;
  const totals = sellerTotals(stats.days);
  return (
    <>
      {stats.error ? (
        <Unavailable
          title={`Activity, last ${days} days`}
          anchors={[PAGING.anchors.daily]}
        />
      ) : (
        <>
          <SectionTitle
            title={`Activity, last ${days} days`}
            meta={`${query.closed ? 'Completed UTC days · ' : ''}${usageMeta(days, stats.aggregatedAt, false)}`}
            range={{ section: 'activity', days }}
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
        offersKnown={!snapshot.error}
      />
      {stats.error ? null : <DailyTable query={query} days={totals.active} />}
    </>
  );
}
