import {
  CircleCheck,
  CircleOff,
  Hash,
  MessagesSquare,
  Timer,
  Wallet,
} from 'lucide-react';

import {
  getCollector,
  type NetworkBuyers,
  type NetworkDay,
} from '../lib/collector';
import { ALL_TIME, DISPLAY, PAGING } from '../lib/constants';
import { count, usdcDecimal } from '../lib/format';
import { rangeOf, tablePager, type ExplorerQuery } from '../lib/paging';
import { displayRange, type RangeDays } from '../lib/range';
import {
  buyersText,
  countText,
  dailyRequests,
  latencyText,
  rateText,
  relayText,
  sideFigures,
  summarizeUsage,
  usageMeta,
  type SideFigures,
} from '../lib/usage';
import { Flow } from './board/animated-number';
import { BarChartCard } from './board/bar-chart-card';
import { delta, type Delta } from './board/delta';
import { StatCard } from './board/stat-card';
import { BuyersCard } from './buyers-card';
import { pagedRows, Pager } from './pager';
import {
  ModelName,
  numberCell,
  SectionTitle,
  SideCells,
  sideColumns,
  Table,
  td,
  Unavailable,
} from './ui';

function FigureCells({
  free,
  paid,
  latency,
}: {
  free: SideFigures;
  paid: SideFigures;
  latency: 'firstToken' | 'total';
}) {
  return (
    <>
      <SideCells free={free.requests} paid={paid.requests} show={countText} />
      <SideCells
        free={free.successRate}
        paid={paid.successRate}
        show={rateText}
      />
      <SideCells
        free={free.outputTokens}
        paid={paid.outputTokens}
        show={countText}
      />
      <SideCells free={free[latency]} paid={paid[latency]} show={latencyText} />
    </>
  );
}
const figureHead = (latency: string) => [
  ...sideColumns('Requests'),
  ...sideColumns('Success'),
  ...sideColumns('Output tokens'),
  ...sideColumns(`${latency} p50`),
];

// Each side's change against the span just before the range; none when that span cannot be read.
function changes(
  current: ReturnType<typeof summarizeUsage>,
  previous: ReturnType<typeof summarizeUsage> | null,
) {
  if (!previous) return null;
  return {
    requests: [
      delta(current.free.requests, previous.free.requests),
      delta(current.paid.requests, previous.paid.requests),
    ],
    outputTokens: [
      delta(current.free.outputTokens, previous.free.outputTokens),
      delta(current.paid.outputTokens, previous.paid.outputTokens),
    ],
    authorized: [delta(current.authorized, previous.authorized)],
    unserved: [delta(current.unserved, previous.unserved, 'down')],
  };
}

function UsageCards({
  usage,
  change,
  buyers,
  days,
}: {
  usage: ReturnType<typeof summarizeUsage>;
  change: ReturnType<typeof changes>;
  buyers: NetworkBuyers | null;
  days: RangeDays;
}) {
  const { free, paid } = usage;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        icon={MessagesSquare}
        label="Requests"
        sides={{
          free: <Flow value={free.requests} kind="count" />,
          paid: <Flow value={paid.requests} kind="count" />,
        }}
        deltas={change?.requests}
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
      <BuyersCard className="col-span-2" buyers={buyers} days={days} />
      <StatCard
        icon={Hash}
        label="Output tokens"
        sides={{
          free: <Flow value={free.outputTokens} kind="count" />,
          paid: <Flow value={paid.outputTokens} kind="count" />,
        }}
        deltas={change?.outputTokens}
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
        hint="Paid usage that buyer and seller both signed for in receipts. It is not settled USDC: that is under Payments."
        value={<Flow value={usdcDecimal(usage.authorized)} kind="usdc" />}
        deltas={change?.authorized}
        money
      />
      <StatCard
        icon={CircleOff}
        label="Unserved demand"
        hint="Requests buyers could not get served: no seller offered the model, or the seller refused."
        value={<Flow value={usage.unserved} kind="count" />}
        deltas={change?.unserved}
      />
    </div>
  );
}

export async function UsageSection({ query }: { query: ExplorerQuery }) {
  const days = rangeOf(query, 'usage');
  const [snapshot, before] = await Promise.all([
    getCollector(days, 0, query.closed),
    days === ALL_TIME ? null : getCollector(days, 1, query.closed),
  ]);
  if (snapshot.error)
    return (
      <Unavailable
        title="Usage"
        anchors={[PAGING.anchors.daily, PAGING.anchors.demand]}
      />
    );
  const usage = summarizeUsage(snapshot);
  const change = changes(
    usage,
    before && !before.error ? summarizeUsage(before) : null,
  );
  return (
    <>
      <SectionTitle
        title={`Usage, ${displayRange(days)}`}
        meta={usageMeta(days, snapshot.aggregatedAt, change !== null)}
        range={{ section: 'usage', days }}
      />
      <UsageCards
        usage={usage}
        change={change}
        buyers={snapshot.buyerTotals}
        days={days}
      />
      <RequestCharts days={snapshot.days} change={change?.requests ?? null} />
      <DailyTable query={query} days={usage.active} />
      <DemandTable query={query} demand={usage.demand} />
    </>
  );
}

// Small multiples, never stacked: free and paid requests per day, each in its own chart.
function RequestCharts({
  days,
  change,
}: {
  days: NetworkDay[];
  change: (Delta | null)[] | null;
}) {
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
        change={change?.[0]}
        total={total('free')}
        points={chart('free')}
      />
      <BarChartCard
        title="Paid requests per day"
        kind="count"
        change={change?.[1]}
        total={total('paid')}
        points={chart('paid')}
      />
    </div>
  );
}

function DailyTable({
  query,
  days,
}: {
  query: ExplorerQuery;
  days: NetworkDay[];
}) {
  const page = pagedRows(query, 'daily', [...days].reverse(), true, {
    day: (day) => day.day,
  });
  const head = [
    { label: 'Day (UTC)', sort: 'day', ascendingFirst: true },
    ...figureHead('Seller first token'),
    ...sideColumns('Input tokens'),
    ...sideColumns('Buyers'),
    { label: 'Relay', right: true },
  ];
  return (
    <>
      <SectionTitle id={PAGING.anchors.daily} title="Daily" />
      <Table
        minWidth={DISPLAY.dailyTable}
        head={head}
        sorting={{ query, table: 'daily' }}
        footer={<Pager label="Daily" view={tablePager(query, 'daily', page)} />}
      >
        {days.length ? null : (
          <tr>
            <td className={`${td} text-muted`} colSpan={head.length}>
              No daily activity in this range.
            </td>
          </tr>
        )}
        {page.rows.map((day) => (
          <tr key={day.day} className="border-t border-line">
            <td className={`${td} font-mono`}>{day.day}</td>
            <FigureCells
              free={sideFigures([day.free])}
              paid={sideFigures([day.paid])}
              latency="firstToken"
            />
            <SideCells
              free={day.free?.tokens.input ?? null}
              paid={day.paid?.tokens.input ?? null}
              show={(value) => (value === null ? '—' : countText(value))}
            />
            <SideCells free={day.free} paid={day.paid} show={buyersText} />
            <td className={numberCell}>{relayText(day)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}

function DemandTable({
  query,
  demand,
}: {
  query: ExplorerQuery;
  demand: [string, number][];
}) {
  const page = pagedRows(query, 'demand', demand, true, {
    requests: ([, requests]) => requests,
  });
  return (
    <>
      <SectionTitle id={PAGING.anchors.demand} title="Unserved demand" />
      <Table
        minWidth={DISPLAY.narrowTable}
        sorting={{ query, table: 'demand' }}
        head={[
          { label: 'Requested model' },
          {
            label: 'Requests',
            right: true,
            sort: 'requests',
            ascendingFirst: true,
          },
        ]}
        footer={
          <Pager
            label="Unserved demand"
            view={tablePager(query, 'demand', page)}
          />
        }
      >
        {!page.total && (
          <tr>
            <td className={td} colSpan={2}>
              No published unserved demand in this period.
            </td>
          </tr>
        )}
        {page.rows.map(([model, requests]) => (
          <tr key={model} className="border-t border-line">
            <td className={td}>
              <ModelName
                days={rangeOf(query, 'usage')}
                closed={query.closed}
                modelId={model}
                variant={null}
                quantization={null}
              />
            </td>
            <td className={numberCell}>{count(requests)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
