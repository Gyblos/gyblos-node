import type { ModelStat, NetworkDay } from '../lib/collector-shape';
import { UNITS } from '../lib/constants';
import { count, percent } from '../lib/format';
import { demandPoints, latencyBars, sideTokens } from '../lib/model-page';
import { BarChartCard } from './board/bar-chart-card';
import { cx } from './board/cx';
import { SURFACE } from './board/styles';

interface ShareRow {
  label: string;
  count: number;
  share: number;
}

const SIDES = ['free', 'paid'] as const;

function ShareBars({ rows, label }: { rows: ShareRow[]; label: string }) {
  if (!rows.length)
    return <p className="mt-3 text-sm text-muted">No samples in this range.</p>;
  return (
    <ul role="list" aria-labelledby={label} className="mt-3 grid gap-1.5">
      {rows.map((row) => (
        <li
          key={row.label}
          className="grid grid-cols-[4.5rem_minmax(2rem,1fr)_3rem] items-center gap-2 text-xs"
          title={`${count(row.count)} · ${percent(row.share)}`}
        >
          <span className="font-mono text-muted">{row.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-raised">
            <span
              className="block h-full rounded-full bg-chart"
              style={{
                width: row.count
                  ? `max(2px, ${row.share * UNITS.percent}%)`
                  : 0,
              }}
            />
          </span>
          <span className="text-right font-mono text-dim tabular-nums">
            {percent(row.share)}
            <span className="sr-only"> · {count(row.count)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function SideCard({
  title,
  caption,
  rows,
}: {
  title: string;
  caption: string;
  rows: Record<(typeof SIDES)[number], ShareRow[]>;
}) {
  return (
    <div className={cx('min-w-0 p-4 sm:p-5', SURFACE.card)}>
      <div className="text-body-medium text-muted">{title}</div>
      <p className="mt-1 text-xs text-dim">{caption}</p>
      <div className="mt-2 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {SIDES.map((side) => (
          <div key={side} className="min-w-0">
            <div
              id={`${title}-${side}`.replaceAll(' ', '-')}
              className="font-mono text-xs text-dim uppercase"
            >
              {title} · {side}
            </div>
            <ShareBars
              rows={rows[side]}
              label={`${title}-${side}`.replaceAll(' ', '-')}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const shares = (rows: { label: string; count: number }[]) => {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return total ? rows.map((row) => ({ ...row, share: row.count / total })) : [];
};

export function ModelCharts({
  stat,
  days,
  modelId,
}: {
  stat: ModelStat | undefined;
  days: NetworkDay[];
  modelId: string;
}) {
  const demand = demandPoints(days, modelId);
  const observed = demand.flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  return (
    <div className="mt-3 grid gap-3">
      <BarChartCard
        title="Unserved demand per day"
        kind="count"
        total={
          observed.length
            ? observed.reduce((sum, value) => sum + value, 0)
            : null
        }
        summary="Requests for this model that no seller answered, summed over days with data"
        points={demand.map((point) => ({
          day: point.day,
          value: point.value,
          amount: point.value,
          detail: point.detail,
        }))}
        startAtEnd
      />
      <div className="grid gap-3 xl:grid-cols-2">
        <SideCard
          title="Seller first token"
          caption="Share of requests by time to the first token"
          rows={{
            free: latencyBars(stat?.free?.sellerLatency.firstToken),
            paid: latencyBars(stat?.paid?.sellerLatency.firstToken),
          }}
        />
        <SideCard
          title="Tokens"
          caption="Input, output and reasoning tokens in the range"
          rows={{
            free: shares(sideTokens(stat?.free ?? null)),
            paid: shares(sideTokens(stat?.paid ?? null)),
          }}
        />
      </div>
    </div>
  );
}
