'use client';

import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { RANGE } from '../lib/constants';
import { count } from '../lib/format';
import { compact, type TokenPoint } from '../lib/overview-activity';
import { CHART } from './board/constants';

const DAY_WIDTH = 16;

export function OverviewChart({
  points,
  total,
}: {
  points: TokenPoint[];
  total: number | null;
}) {
  return (
    <section className="ov-panel">
      <div className="ov-heading">
        <h3>Tokens processed</h3>
      </div>
      <strong>{total === null ? '—' : compact(total)}</strong>
      {total === null ? (
        <p className="ov-empty">No token observations in this period.</p>
      ) : (
        <TokenPlot data={points} />
      )}
      <details>
        <summary>View data</summary>
        <div className="ov-scroll">
          <table>
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th>Tokens observed</th>
              </tr>
            </thead>
            <tbody>
              {points.map((row) => (
                <tr key={row.day}>
                  <td>{row.day}</td>
                  <td>{row.tokens === null ? 'No data' : count(row.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function TokenPlot({ data }: { data: TokenPoint[] }) {
  return (
    <div
      className="ov-chart-scroll"
      tabIndex={0}
      role="region"
      aria-label="Daily tokens, scroll for all dates"
    >
      <div
        className="ov-plot"
        style={{ minWidth: data.length * DAY_WIDTH + CHART.axisWidth }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            accessibilityLayer
            margin={{ left: 0, right: 4, top: 8, bottom: 0 }}
          >
            <XAxis
              dataKey="day"
              tickFormatter={(value: string) =>
                value.slice(CHART.monthDayStart, RANGE.dayPrecision)
              }
              interval={0}
              angle={-90}
              textAnchor="end"
              height={40}
              tickLine={false}
              axisLine={false}
              stroke="var(--dim)"
              fontSize={11}
            />
            <YAxis
              width={40}
              tickCount={4}
              tickFormatter={compact}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              stroke="var(--dim)"
              fontSize={11}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--raised)',
                border: 0,
                color: 'var(--ink)',
              }}
              cursor={{ fill: 'var(--raised)' }}
              formatter={(value) => [count(Number(value)), 'Tokens']}
            />
            <Bar
              dataKey="tokens"
              fill="var(--chart)"
              radius={[CHART.barRadius, CHART.barRadius, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
