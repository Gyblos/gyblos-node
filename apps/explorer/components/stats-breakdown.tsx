import Link from 'next/link';

import { PAGING, STATS } from '../lib/constants';
import { count, usdcDecimal } from '../lib/format';
import {
  queryHref,
  statsBreakdownHref,
  tablePager,
  type ExplorerQuery,
  type StatsMetric,
} from '../lib/paging';
import type { readComparison } from './activity-report';
import { Flow } from './board/animated-number';
import { Chip } from './board/chip';
import { DeltaChip } from './board/delta-chip';
import { pagedRows, Pager } from './pager';
import { numberCell, SectionTitle, Table, td } from './ui';

const LABELS = {
  tokens: 'Tokens processed',
  requests: 'Recorded requests',
  paidOut: 'Paid to sellers',
} as const;

export function BreakdownLinks({ query }: { query: ExplorerQuery }) {
  const metrics: StatsMetric[] =
    query.tab === 'payments' ? ['paidOut'] : ['tokens', 'requests'];
  return (
    <nav
      aria-label="Daily breakdowns"
      className="my-4 flex flex-wrap gap-x-4 gap-y-2 text-sm"
    >
      {metrics.map((metric) => (
        <Link
          key={metric}
          aria-current={query.metric === metric ? 'page' : undefined}
          className="text-muted underline underline-offset-4 hover:text-ink"
          href={statsBreakdownHref(metric, query.days)}
        >
          {LABELS[metric]} by day
        </Link>
      ))}
    </nav>
  );
}

export function StatsBreakdown({
  query,
  report,
  metric,
}: {
  query: ExplorerQuery;
  report: Awaited<ReturnType<typeof readComparison>>;
  metric: StatsMetric;
}) {
  const data = report.metrics[metric];
  const period = report.period;
  const payments = STATS.metrics[metric] === 'payments';
  const table = payments ? 'chainDaily' : 'daily';
  const label = LABELS[metric];
  const sides = new Map(period.source?.days.map((day) => [day.day, day]));
  const rows = period.dates
    .map((day, index) => {
      const row = sides.get(day);
      const point = period.activity.points[index];
      const left =
        metric === 'tokens' ? point?.input : row?.free?.requests.headline;
      const right =
        metric === 'tokens' ? point?.output : row?.paid?.requests.headline;
      const paidOut = period.paid.points[index] ?? null;
      const value = metric === 'paidOut' ? paidOut : (point?.[metric] ?? null);
      return { day, left: left ?? null, right: right ?? null, value, paidOut };
    })
    .reverse();
  const page = pagedRows(query, table, rows, true, {
    day: (row) => row.day,
    paidOut: (row) => row.paidOut,
  });

  const full =
    queryHref({
      ...query,
      metric: undefined,
      pages: { ...query.pages, [table]: 1 },
    }) +
    '#' +
    PAGING.anchors[table];
  return (
    <section aria-label={label + ' breakdown'}>
      <SectionTitle
        id={PAGING.anchors[table]}
        title={label + ' by day'}
        meta={
          <Link className="underline underline-offset-4" href={full}>
            All daily indicators
          </Link>
        }
      />
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <span className="font-mono text-2xl">
          <Flow value={data.total} kind={payments ? 'usdc' : 'count'} />
        </span>
        {data.change ? (
          <DeltaChip delta={data.change} />
        ) : (
          <Chip>No baseline</Chip>
        )}
        <span className="text-xs text-muted">
          {data.comparison} · {data.sample}
        </span>
      </div>
      <Table
        minWidth={0}
        head={[
          { label: 'Day (UTC)', sort: 'day', ascendingFirst: true },
          ...(payments
            ? []
            : [
                {
                  label: metric === 'tokens' ? 'Input tokens' : 'Free',
                  right: true,
                },
                {
                  label: metric === 'tokens' ? 'Output tokens' : 'Paid',
                  right: true,
                },
              ]),
          {
            label: payments ? 'Paid to sellers (USDC)' : 'Total',
            right: true,
            ...(payments ? { sort: 'paidOut' } : {}),
          },
        ]}
        sorting={{ query, table }}
        footer={<Pager label={label} view={tablePager(query, table, page)} />}
      >
        {page.rows.map((row) => (
          <tr key={row.day} className="border-t border-line">
            <td className={td}>{row.day}</td>
            {!payments && (
              <>
                <td className={numberCell}>
                  {row.left === null ? '—' : count(row.left)}
                </td>
                <td className={numberCell}>
                  {row.right === null ? '—' : count(row.right)}
                </td>
              </>
            )}
            <td className={numberCell}>
              {row.value === null
                ? 'No observation'
                : typeof row.value === 'bigint'
                  ? usdcDecimal(row.value)
                  : count(row.value)}
            </td>
          </tr>
        ))}
        {!page.total && (
          <tr>
            <td className={td} colSpan={payments ? 2 : 4}>
              No observations in this period.
            </td>
          </tr>
        )}
      </Table>
    </section>
  );
}
