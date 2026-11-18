'use client';

// A daily bar chart in a card, after BoardUI's chart cards (MIT, see ./LICENSE), drawn with Recharts and
// held to the explorer's chart rules: one series in the brand blue, no gradients, the headline readable
// without hover. Hovering a day swaps the headline for that day's figure, as BoardUI's cards do.
// Values arrive preformatted from the server; `value` only sets the bar's height.
import { useState } from 'react';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { CHART, DISPLAY } from '../../lib/constants';

const TICK = {
  fill: 'var(--dim)',
  fontSize: CHART.tickFontSize,
  fontFamily: 'var(--font-mono)',
};

export interface BarPoint {
  day: string;
  value: number;
  label: string;
}

export function BarChartCard({
  title,
  total,
  points,
  countAxis = true,
}: {
  title: string;
  total: string;
  points: BarPoint[];
  // A count axis (whole numbers); amounts hide it and read from the headline instead.
  countAxis?: boolean;
}) {
  const [active, setActive] = useState<BarPoint | null>(null);
  const dense = points.length > CHART.denseDays;
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-sm text-muted">{title}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-2xl">{active?.label ?? total}</span>
        <span className="font-mono text-xs text-dim">
          {active ? active.day : `${points.length} days`}
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
            onMouseMove={(state) => {
              const index = Number(state.activeTooltipIndex);
              setActive(
                Number.isInteger(index) ? (points[index] ?? null) : null,
              );
            }}
            onMouseLeave={() => setActive(null)}
          >
            <XAxis
              dataKey="day"
              tickFormatter={(day: string) => day.slice(DISPLAY.monthDayStart)}
              interval={dense ? 'preserveStartEnd' : 0}
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
              tick={TICK}
              minTickGap={CHART.minTickGap}
            />
            <YAxis
              hide={!countAxis}
              width={CHART.axisWidth}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={TICK}
            />
            <Tooltip cursor={{ fill: 'var(--raised)' }} content={() => null} />
            <Bar
              dataKey="value"
              fill="var(--brand-blue)"
              radius={[CHART.barRadius, CHART.barRadius, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
