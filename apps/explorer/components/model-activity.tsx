import {
  CircleCheck,
  Hash,
  MessagesSquare,
  Server,
  Timer,
  Wallet,
} from 'lucide-react';

import type { ModelSide, ModelStat, NetworkDay } from '../lib/collector-shape';
import { DISPLAY } from '../lib/constants';
import {
  count,
  latencyMs,
  percent,
  tokensPerSecond,
  usdcDecimal,
} from '../lib/format';
import { mergedLatency } from '../lib/latency';
import { Flow } from './board/animated-number';
import { delta, type Delta } from './board/delta';
import { StatCard } from './board/stat-card';
import { ModelCharts } from './model-charts';
import { numberCell, Table, td } from './ui';

const SIDES = ['free', 'paid'] as const;
type Figure = (side: ModelSide) => number | null;

const firstToken = (side: ModelSide) =>
  mergedLatency([side.sellerLatency.firstToken], DISPLAY.median);
const figures = {
  requests: (side) => side.requests.headline,
  success: (side) => side.successRate,
  output: (side) => side.tokens.output,
  sellers: (side) => side.sellers,
} satisfies Record<string, Figure>;

function sampled(value: string, samples: number | undefined) {
  if (!samples) return '—';
  return `${value} · ${count(samples)} ${samples === 1 ? 'sample' : 'samples'}`;
}

const measures: { label: string; value: (side: ModelSide) => string }[] = [
  { label: 'Completed', value: (side) => count(side.outcomes.completed) },
  { label: 'Failed', value: (side) => count(side.outcomes.failed) },
  { label: 'Cancelled', value: (side) => count(side.outcomes.cancelled) },
  { label: 'Input tokens', value: (side) => count(side.tokens.input) },
  { label: 'Reasoning tokens', value: (side) => count(side.tokens.reasoning) },
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

function changes(
  stat: ModelStat | undefined,
  previous: ModelStat | undefined | null,
  figure: Figure,
): (Delta | null)[] | undefined {
  if (previous === null) return undefined;
  return SIDES.map((side) => {
    const now = stat?.[side] ? figure(stat[side]) : null;
    const then = previous?.[side] ? figure(previous[side]) : null;
    return now === null || then === null || then <= 0 ? null : delta(now, then);
  });
}

function sides(stat: ModelStat | undefined, show: (side: ModelSide) => string) {
  return {
    free: stat?.free ? show(stat.free) : '—',
    paid: stat?.paid ? show(stat.paid) : '—',
  };
}

function Kpis({
  stat,
  previous,
}: {
  stat: ModelStat | undefined;
  previous: ModelStat | undefined | null;
}) {
  const shown = (figure: Figure, kind: 'count' | 'percent') => ({
    free: <Flow value={stat?.free ? figure(stat.free) : null} kind={kind} />,
    paid: <Flow value={stat?.paid ? figure(stat.paid) : null} kind={kind} />,
  });
  const authorized = stat?.paid?.authorizedAtomic;
  return (
    <div className="grid grid-cols-1 gap-3 min-[390px]:grid-cols-2 lg:grid-cols-3">
      <StatCard
        icon={MessagesSquare}
        label="Requests"
        sides={shown(figures.requests, 'count')}
        deltas={changes(stat, previous, figures.requests)}
      />
      <StatCard
        icon={CircleCheck}
        label="Success"
        sides={sides(stat, (side) =>
          side.successRate === null ? '—' : percent(side.successRate),
        )}
        deltas={changes(stat, previous, figures.success)}
        hint="Completed requests out of completed and failed ones. Cancellations are not counted as failures."
      />
      <StatCard
        icon={Hash}
        label="Output tokens"
        sides={shown(figures.output, 'count')}
        deltas={changes(stat, previous, figures.output)}
      />
      <StatCard
        icon={Timer}
        label="Seller first token p50"
        sides={sides(stat, (side) => latencyMs(firstToken(side)))}
      />
      <StatCard
        icon={Wallet}
        label="Authorized (paid)"
        value={
          <Flow
            value={authorized ? usdcDecimal(BigInt(authorized)) : null}
            kind="usdc"
          />
        }
        caption="Usage both sides signed for, not settled USDC"
        money
      />
      <StatCard
        icon={Server}
        label="Sellers that served it"
        sides={shown(figures.sellers, 'count')}
        deltas={changes(stat, previous, figures.sellers)}
      />
    </div>
  );
}

function DetailTable({ stat }: { stat: ModelStat }) {
  return (
    <Table
      minWidth={DISPLAY.narrowTable}
      footer={
        <p className="px-4 py-3 text-xs text-dim">
          Receipts, outcomes and observations behind the figures above
        </p>
      }
      head={[
        { label: 'Metric' },
        { label: 'Free', right: true },
        { label: 'Paid', right: true },
      ]}
    >
      {measures.map(({ label, value }) => (
        <tr key={label} className="border-t border-line">
          <td className={td}>{label}</td>
          <td className={numberCell}>{stat.free ? value(stat.free) : '—'}</td>
          <td className={numberCell}>{stat.paid ? value(stat.paid) : '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

export function ModelActivity({
  stat,
  previous,
  days,
  modelId,
}: {
  stat: ModelStat | undefined;
  previous: ModelStat | undefined | null;
  days: NetworkDay[];
  modelId: string;
}) {
  return (
    <>
      <Kpis stat={stat} previous={previous} />
      {stat ? null : (
        <p className="mt-2 text-xs text-dim">
          No published aggregate for this variant in the selected period. The
          collector publishes the {count(DISPLAY.maxPublicModels)} most used
          models.
        </p>
      )}
      <ModelCharts stat={stat} days={days} modelId={modelId} />
      {stat ? (
        <>
          <h3 className="mt-6 mb-2 text-body-medium text-muted">Detail</h3>
          <DetailTable stat={stat} />
        </>
      ) : null}
    </>
  );
}
