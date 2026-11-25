import Link from 'next/link';

import { PAGING, STATS } from '../lib/constants';
import { count, usdcDecimal } from '../lib/format';
import {
  queryHref,
  tablePager,
  type ExplorerQuery,
  type StatsMetric,
} from '../lib/paging';
import { dailyRequests } from '../lib/usage';
import type { readComparison } from './activity-report';
import { BarChartCard } from './board/bar-chart-card';
import { pagedRows, Pager } from './pager';
import {
  EmptyRow,
  numberCell,
  SectionTitle,
  Table,
  td,
  type Column,
} from './ui';

const LABELS = {
  tokens: 'Tokens processed',
  requests: 'Recorded requests',
  paidOut: 'Paid to sellers',
} as const;

type Report = Awaited<ReturnType<typeof readComparison>>;
function breakdownRows(period: Report['period'], metric: StatsMetric) {
  const requests = dailyRequests(period.source?.days ?? [], period.dates);
  return period.dates
    .map((day, index) => {
      const row = requests[index];
      const point = period.activity.points[index];
      const left = metric === 'tokens' ? point?.input : row?.free;
      const right = metric === 'tokens' ? point?.output : row?.paid;
      const paidOut = period.paid.points[index] ?? null;
      const value = metric === 'paidOut' ? paidOut : (point?.[metric] ?? null);
      return { day, left: left ?? null, right: right ?? null, value, paidOut };
    })
    .reverse();
}
function breakdownHead(metric: StatsMetric, payments: boolean): Column[] {
  return [
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
  ];
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
  const rows = breakdownRows(period, metric);
  const chartPoints = [...rows].reverse().map((row) => {
    const amount =
      typeof row.value === 'bigint' ? usdcDecimal(row.value) : row.value;
    return {
      day: row.day,
      value: amount === null ? null : Number(amount),
      amount,
    };
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
      <div className="mb-3">
        <BarChartCard
          title={label}
          kind={payments ? 'usdc' : 'count'}
          total={data.total}
          change={data.change}
          points={chartPoints}
          countAxis={!payments}
          comparison={data.comparison}
        />
      </div>
      <BreakdownTable query={query} rows={rows} metric={metric} />
    </section>
  );
}

function BreakdownTable({
  query,
  rows,
  metric,
}: {
  query: ExplorerQuery;
  rows: ReturnType<typeof breakdownRows>;
  metric: StatsMetric;
}) {
  const label = LABELS[metric];
  const payments = STATS.metrics[metric] === 'payments';
  const table = payments ? 'chainDaily' : 'daily';
  const head = breakdownHead(metric, payments);
  const page = pagedRows(query, table, rows, true, {
    day: (row) => row.day,
    paidOut: (row) => row.paidOut,
  });

  return (
    <Table
      minWidth={0}
      head={head}
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
        <EmptyRow columns={head.length}>
          No observations in this period.
        </EmptyRow>
      )}
    </Table>
  );
}
