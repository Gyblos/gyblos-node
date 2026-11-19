// Owns the Usage section: what the metrics collector aggregated from signed receipts and observations
// over the last 30 UTC days. Every figure is a "free · paid" pair, never a sum: free volume is not
// backed by payment. Buyer counts below the public minimum show as "< 5".
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
  type ModelStat,
  type NetworkDay,
  type NetworkSide,
} from '../lib/collector';
import { DISPLAY } from '../lib/constants';
import { count, usdcDecimal, utc } from '../lib/format';
import type { RangeDays } from '../lib/range';
import {
  countText,
  dailyRequests,
  latencyText,
  pair,
  rateText,
  relayText,
  sideFigures,
  summarizeUsage,
  type SideFigures,
} from '../lib/usage';
import { Flow, FlowPair } from './board/animated-number';
import { BarChartCard } from './board/bar-chart-card';
import { delta, type Delta } from './board/delta';
import { StatCard } from './board/stat-card';
import {
  ModelName,
  numberCell,
  SectionTitle,
  Table,
  td,
  Unavailable,
} from './ui';

const buyersText = (side: NetworkSide | null) =>
  !side
    ? '—'
    : side.withheld
      ? `< ${DISPLAY.minPublicBuyers}`
      : count(side.buyers ?? 0);
// One row's "free · paid" figure cells.
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
      <td className={numberCell}>
        {pair(free.requests, paid.requests, countText)}
      </td>
      <td className={numberCell}>
        {pair(free.successRate, paid.successRate, rateText)}
      </td>
      <td className={numberCell}>
        {pair(free.outputTokens, paid.outputTokens, countText)}
      </td>
      <td className={numberCell}>
        {pair(free[latency], paid[latency], latencyText)}
      </td>
    </>
  );
}
const figureHead = (latency: string) => [
  { label: 'Requests free · paid', right: true },
  { label: 'Success free · paid', right: true },
  { label: 'Output tokens free · paid', right: true },
  { label: `${latency} p50 free · paid`, right: true },
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

export async function UsageSection({ days }: { days: RangeDays }) {
  const [snapshot, before] = await Promise.all([
    getCollector(days),
    getCollector(days, 1),
  ]);
  if (snapshot.error) return <Unavailable title="Usage" />;
  const usage = summarizeUsage(snapshot);
  const change = changes(usage, before.error ? null : summarizeUsage(before));
  const { free, paid } = usage;
  return (
    <>
      <SectionTitle
        title={`Usage · ${days} days`}
        meta={
          snapshot.aggregatedAt
            ? `vs previous ${days} days · updated ${utc(snapshot.aggregatedAt)}`
            : 'no data yet'
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          icon={MessagesSquare}
          label="Requests free · paid"
          value={
            <FlowPair free={free.requests} paid={paid.requests} kind="count" />
          }
          deltas={change?.requests}
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
          deltas={change?.outputTokens}
        />
        <StatCard
          icon={Timer}
          label="First token p50 free · paid"
          value={pair(free.firstToken, paid.firstToken, latencyText)}
        />
        <StatCard
          icon={Wallet}
          label="Authorized (paid)"
          value={<Flow value={usdcDecimal(usage.authorized)} kind="usdc" />}
          deltas={change?.authorized}
          money
        />
        <StatCard
          icon={CircleOff}
          label="Unserved demand"
          value={<Flow value={usage.unserved} kind="count" />}
          deltas={change?.unserved}
        />
      </div>
      <RequestCharts days={snapshot.days} change={change?.requests ?? null} />
      <DailyTable days={usage.active} />
      <ModelsTable models={snapshot.models} />
      <DemandTable demand={usage.demand} />
    </>
  );
}

// Small multiples, never stacked: free and paid requests per day, each in its own chart.
function RequestCharts({
  days,
  change,
}: {
  days: NetworkDay[];
  change: Delta[] | null;
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

function DailyTable({ days }: { days: NetworkDay[] }) {
  return (
    <>
      <SectionTitle title="Daily" />
      <Table
        minWidth={DISPLAY.dailyTable}
        head={[
          { label: 'Day (UTC)' },
          ...figureHead('First token'),
          { label: 'Buyers free · paid', right: true },
          { label: 'Relay', right: true },
        ]}
      >
        {[...days].reverse().map((day) => (
          <tr key={day.day} className="border-t border-line">
            <td className={`${td} font-mono`}>{day.day}</td>
            <FigureCells
              free={sideFigures([day.free])}
              paid={sideFigures([day.paid])}
              latency="firstToken"
            />
            <td className={numberCell}>
              {buyersText(day.free)} · {buyersText(day.paid)}
            </td>
            <td className={numberCell}>{relayText(day)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}

function ModelsTable({ models }: { models: ModelStat[] }) {
  return (
    <>
      <SectionTitle title="Models served" />
      <Table
        minWidth={DISPLAY.dailyTable}
        head={[
          { label: 'Model' },
          ...figureHead('Total'),
          { label: 'Sellers free · paid', right: true },
        ]}
      >
        {models.map((model) => (
          <tr
            key={`${model.modelId}:${model.variant}:${model.quantization}`}
            className="border-t border-line"
          >
            <td className={td}>
              <ModelName
                modelId={model.modelId}
                variant={model.variant}
                quantization={model.quantization}
              />
            </td>
            <FigureCells
              free={sideFigures([model.free])}
              paid={sideFigures([model.paid])}
              latency="total"
            />
            <td className={numberCell}>
              {pair(model.free?.sellers, model.paid?.sellers, (value) =>
                value === undefined ? '—' : count(value),
              )}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}

function DemandTable({ demand }: { demand: [string, number][] }) {
  if (!demand.length) return null;
  return (
    <>
      <SectionTitle title="Unserved demand" />
      <Table
        minWidth={DISPLAY.narrowTable}
        head={[
          { label: 'Requested model' },
          { label: 'Requests', right: true },
        ]}
      >
        {demand.map(([model, requests]) => (
          <tr key={model} className="border-t border-line">
            <td className={td}>{model}</td>
            <td className={numberCell}>{count(requests)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
