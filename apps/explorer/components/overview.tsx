import {
  Activity,
  Hash,
  MessagesSquare,
  Server,
  type LucideIcon,
} from 'lucide-react';

import { overviewNetwork } from '../lib/collector';
import { DISPLAY, UNITS } from '../lib/constants';
import { getDiscovery } from '../lib/discovery-render';
import { count, percent, utc } from '../lib/format';
import { compact, overviewActivity } from '../lib/overview-activity';
import { rangeOf, type ExplorerQuery } from '../lib/paging';
import { overviewWindow } from '../lib/range';
import { delta, type Delta } from './board/delta';
import { DeltaChip } from './board/delta-chip';
import { OverviewChart } from './overview-chart';
import { RangeControl } from './range-control';

type ActivityTotals = ReturnType<typeof overviewActivity>;
function Metric({
  icon: Icon,
  label,
  value,
  change,
  detail,
  caption,
}: {
  icon: LucideIcon;
  label: string;
  value: number | null;
  change?: Delta | null;
  detail?: string;
  caption?: string;
}) {
  return (
    <section className="ov-panel ov-kpi">
      <Icon size={27} aria-hidden />
      <h3>{label}</h3>
      <div className="ov-value">
        <strong>{value === null ? '—' : compact(value)}</strong>
        {change && <DeltaChip delta={change} />}
      </div>
      {caption && <small>{caption}</small>}
      {value !== null && (
        <details>
          <summary
            aria-label={`Exact ${label.toLowerCase()} and source details`}
          >
            Details
          </summary>
          <small>
            {count(value)} · {detail ?? caption}
          </small>
        </details>
      )}
    </section>
  );
}

function Mix({
  activity,
  metric,
}: {
  activity: ActivityTotals;
  metric: 'requests' | 'tokens';
}) {
  const free = activity.free?.[metric];
  const paid = activity.paid?.[metric];
  const total = activity[metric];
  const known =
    free !== undefined && paid !== undefined && total !== null && total > 0;
  const ratio = known ? free / total : null;
  const requests = metric === 'requests';
  return (
    <section className="ov-panel">
      <h3>{requests ? 'Requests' : 'Tokens'} by mode</h3>
      {ratio === null ? (
        <p className="ov-empty">
          {total === 0
            ? 'No recorded activity.'
            : 'Share unavailable for this period.'}
        </p>
      ) : requests ? (
        <div className="ov-gauge">
          <svg viewBox="0 0 200 110" aria-hidden>
            <path
              strokeLinecap="round"
              d="M 12 100 A 88 88 0 0 1 188 100"
              pathLength="100"
              fill="none"
              stroke={ratio === 1 ? 'var(--chart)' : 'var(--good)'}
              strokeWidth="16"
            />
            {ratio > 0 && (
              <path
                strokeLinecap={ratio === 1 ? 'round' : 'butt'}
                d="M 12 100 A 88 88 0 0 1 188 100"
                pathLength="100"
                fill="none"
                stroke="var(--chart)"
                strokeWidth="16"
                strokeDasharray={`${ratio * UNITS.percent} 100`}
              />
            )}
          </svg>
          <div>
            <strong>{percent(ratio)}</strong>
            <small>Free requests</small>
          </div>
        </div>
      ) : (
        <div className="ov-shares">
          {[
            { name: 'Free', share: ratio },
            { name: 'Paid', share: (paid ?? 0) / (total ?? 1) },
          ].map(({ name, share }) => (
            <div key={name} data-mode={name}>
              <div>
                {name}
                <b>{percent(share)}</b>
              </div>
              <div className="ov-track">
                <i style={{ width: `${share * UNITS.percent}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="ov-split">
        {(['free', 'paid'] as const).map((mode) => (
          <div key={mode} data-mode={mode}>
            <small>{mode === 'free' ? 'Free' : 'Paid'}</small>
            <b>{activity[mode] ? count(activity[mode][metric]) : '—'}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

export async function Overview({ query }: { query: ExplorerQuery }) {
  const days = rangeOf(query, 'overview');
  const now = Date.now();
  const dates = overviewWindow(days, now);
  const prior = overviewWindow(days, now, 1);
  const [source, before, snapshot] = await Promise.all([
    overviewNetwork(dates),
    overviewNetwork(prior),
    getDiscovery(),
  ]);
  const current = overviewActivity(dates, source);
  const previous = overviewActivity(prior, before);
  const interval = (window: string[]) => `${window[0]} – ${window.at(-1)} UTC`;
  const metric = (key: 'tokens' | 'requests' | 'demand') => {
    const currentValue = current[key];
    const previousValue = previous[key];
    const coverage = key === 'demand' ? 'demandComplete' : 'complete';
    const comparable =
      current[coverage] &&
      previous[coverage] &&
      source?.version === before?.version &&
      currentValue !== null &&
      previousValue !== null;
    return {
      value: currentValue,
      change: comparable
        ? delta(currentValue, previousValue, key === 'demand' ? 'down' : 'up')
        : null,
      detail: `${interval(dates)}. Previous observed: ${previousValue === null ? 'unavailable' : count(previousValue)} · ${interval(prior)}.${comparable ? '' : ' Complete comparison coverage unavailable.'}`,
    };
  };
  return (
    <>
      <div className="ov-title">
        <h2>Network overview</h2>
        <RangeControl section="overview" days={days} />
      </div>
      <p className="ov-meta">
        {interval(dates)} <span>compared with</span> {interval(prior)}
      </p>
      <div className="ov-kpis">
        <Metric icon={Hash} label="Tokens processed" {...metric('tokens')} />
        <Metric
          icon={MessagesSquare}
          label="Recorded requests"
          {...metric('requests')}
        />
        <Metric
          icon={Server}
          label="Sellers online"
          value={
            snapshot.error
              ? null
              : (snapshot.network?.counts.online ?? snapshot.sellers.length)
          }
          caption={
            snapshot.error
              ? 'Discovery unavailable'
              : `${snapshot.network?.truncated ? 'Partial count · ' : ''}As of ${utc(snapshot.datedAt ?? snapshot.generatedAt)}`
          }
        />
        <Metric
          icon={Activity}
          label="Unserved attempts"
          {...metric('demand')}
          caption={`Buyer observations · up to ${DISPLAY.demandModelsPerDay} models/day`}
        />
      </div>
      <div className="ov-analysis">
        <OverviewChart points={current.points} total={current.tokens} />
        <Mix activity={current} metric="requests" />
        <Mix activity={current} metric="tokens" />
      </div>
      <p className="ov-meta">
        {source
          ? `Published receipt totals · ${current.daysObserved} of ${days} days with observations · Aggregated ${utc(source.updated)}`
          : 'Metrics collector unavailable.'}
      </p>
    </>
  );
}
