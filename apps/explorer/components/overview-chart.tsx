'use client';

import { useState } from 'react';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { count } from '../lib/format';
import { compact, groupWeeks, type TokenPoint } from '../lib/overview-activity';
import { SegmentedControl } from './board/segmented-control';

export function OverviewChart({
  points,
  total,
}: {
  points: TokenPoint[];
  total: number | null;
}) {
  const [group, setGroup] = useState('days');
  const data =
    group === 'weeks'
      ? groupWeeks(points).map((week) => ({
          day: week.day,
          label: `${week.day} – ${week.end}${week.missing ? ' (partial coverage)' : ''}`,
          tokens: week.tokens,
        }))
      : points.map((point) => ({ ...point, label: point.day }));
  return (
    <section className="ov-panel">
      <div className="ov-heading">
        <h3>Tokens processed</h3>
        <SegmentedControl
          label="Group token bars"
          options={[
            { value: 'days', label: 'Days' },
            { value: 'weeks', label: 'Weeks' },
          ]}
          selected={group}
          onChange={setGroup}
        />
      </div>
      <strong>{total === null ? '—' : compact(total)}</strong>
      {total === null ? (
        <p className="ov-empty">No token observations in this period.</p>
      ) : (
        <div className="ov-plot">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              accessibilityLayer
              margin={{ left: 0, right: 4, top: 8, bottom: 0 }}
            >
              <XAxis
                dataKey="label"
                tickFormatter={(value: string) => value.slice(5, 10)}
                minTickGap={22}
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
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <details>
        <summary>View data</summary>
        <div className="ov-scroll">
          <table>
            <thead>
              <tr>
                <th>Interval (UTC)</th>
                <th>Tokens observed</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.day}>
                  <td>{row.label}</td>
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
