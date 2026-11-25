'use client';

// A daily bar chart in a card, after BoardUI's chart cards (MIT, see ./LICENSE), drawn with Recharts and
// held to the explorer's chart rules: one series in the brand blue (its signal tone on dark surfaces, where
// #0a28f0 reaches only 1.95:1 against the card; data marks need 3:1), no gradients, the headline readable
// without hover. Hovering a day rolls the headline to that day's figure (NumberFlow), as BoardUI's
// cards swap it. `value` only sets the bar's height; `amount` is the exact figure shown.
import { useState } from 'react';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Flow, type FlowKind, type FlowValue } from './animated-number';
import { barAxis } from './bar-axis';
import { CHART } from './constants';
import { cx } from './cx';
import type { Delta } from './delta';
import { DeltaChip } from './delta-chip';
import { hoveredPoint } from './hovered';
import { SURFACE } from './styles';

const TICK = {
  fill: 'var(--dim)',
  fontSize: CHART.tickFontSize,
  fontFamily: 'var(--font-mono)',
};

export interface BarPoint {
  day: string;
  value: number | null;
  amount: FlowValue;
  // Shown next to the day while hovered (e.g. "3 settlements").
  detail?: string;
}

export function BarChartCard({
  title,
  kind,
  total,
  points,
  change,
  countAxis = true,
}: {
  title: string;
  kind: FlowKind;
  total: FlowValue;
  // The total's change against the previous period; hidden while a day is hovered.
  change?: Delta | null;
  points: BarPoint[];
  // A count axis (whole numbers); amounts hide it and read from the headline instead.
  countAxis?: boolean;
}) {
  const [active, setActive] = useState<BarPoint | null>(null);
  const dense = points.length > CHART.denseDays;
  return (
    <div className={cx('p-4 sm:p-5', SURFACE.card)}>
      <div className="text-sm text-muted">{title}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="font-mono text-2xl">
          <Flow value={active ? active.amount : total} kind={kind} />
        </span>
        {change && !active ? <DeltaChip delta={change} /> : null}
        <span className="font-mono text-xs text-dim">
          {active
            ? [
                active.day,
                active.amount === null ? 'No observation' : active.detail,
              ]
                .filter(Boolean)
                .join(', ')
            : `${points.length} days`}
        </span>
      </div>
      <div className="mt-3" style={{ height: CHART.height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={points}
            margin={{
              top: CHART.topMargin,
              right: CHART.rightMargin,
              bottom: 0,
              left: 0,
            }}
            onMouseMove={(state) =>
              setActive(hoveredPoint(points, state.activeTooltipIndex))
            }
            onMouseLeave={() => setActive(null)}
          >
            <XAxis
              dataKey="day"
              tickFormatter={(day: string) => day.slice(CHART.monthDayStart)}
              interval={dense ? 'preserveStartEnd' : 0}
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
              tick={TICK}
              minTickGap={CHART.minTickGap}
            />
            <YAxis
              {...barAxis(countAxis)}
              width={CHART.axisWidth}
              tickLine={false}
              axisLine={false}
              tick={TICK}
            />
            <Tooltip cursor={{ fill: 'var(--line)' }} content={() => null} />
            <Bar
              dataKey="value"
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
