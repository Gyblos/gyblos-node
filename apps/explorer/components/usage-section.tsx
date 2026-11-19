// Owns the Usage section: what the metrics collector aggregated from signed receipts and observations
// over the last 30 UTC days. Every figure is a "free · paid" pair, never a sum: free volume is not
// backed by payment. Buyer counts below the public minimum show as "< 5".
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
import { BarChartCard } from './board/bar-chart-card';
import { Flow, FlowPair } from './flow';
import {
  ModelName,
  numberCell,
  SectionTitle,
  Stat,
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

export async function UsageSection({ days }: { days: RangeDays }) {
  const snapshot = await getCollector(days);
  if (snapshot.error) return <Unavailable title="Usage" />;
  const usage = summarizeUsage(snapshot);
  const { free, paid } = usage;
  return (
    <>
      <SectionTitle
        title={`Usage · ${days} days`}
        meta={
          snapshot.aggregatedAt
            ? `updated ${utc(snapshot.aggregatedAt)}`
            : 'no data yet'
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat
          label="Requests free · paid"
          value={
            <FlowPair free={free.requests} paid={paid.requests} kind="count" />
          }
        />
        <Stat
          label="Success free · paid"
          value={
            <FlowPair
              free={free.successRate}
              paid={paid.successRate}
              kind="percent"
            />
          }
        />
        <Stat
          label="Output tokens free · paid"
          value={
            <FlowPair
              free={free.outputTokens}
              paid={paid.outputTokens}
              kind="count"
            />
          }
        />
        <Stat
          label="First token p50 free · paid"
          value={pair(free.firstToken, paid.firstToken, latencyText)}
        />
        <Stat
          label="Authorized (paid)"
          value={<Flow value={usdcDecimal(usage.authorized)} kind="usdc" />}
          money
        />
        <Stat
          label="Unserved demand"
          value={<Flow value={usage.unserved} kind="count" />}
        />
      </div>
      <RequestCharts days={snapshot.days} />
      <DailyTable days={usage.active} />
      <ModelsTable models={snapshot.models} />
      <DemandTable demand={usage.demand} />
    </>
  );
}

// Small multiples, never stacked: free and paid requests per day, each in its own chart.
function RequestCharts({ days }: { days: NetworkDay[] }) {
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
