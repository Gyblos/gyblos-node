'use client';

import { useState } from 'react';

import { SELLERS_ONLINE } from '../lib/constants';
import {
  sellersOnlinePoints,
  sellersOnlineSummary,
  type SellersOnlineDay,
} from '../lib/sellers-online';
import { BarChartCard } from './board/bar-chart-card';
import { SegmentedControl } from './board/segmented-control';

type ShownDays = (typeof SELLERS_ONLINE.windows)[number];
const OPTIONS = SELLERS_ONLINE.windows.map((days) => ({
  value: days,
  label: `${days}d`,
}));

export function SellersOnlineChart({
  days,
}: {
  days: readonly SellersOnlineDay[];
}) {
  const [count, setCount] = useState<ShownDays>(SELLERS_ONLINE.defaultWindow);
  const shown = days.slice(-count);
  const { average, fullDays } = sellersOnlineSummary(shown);
  return (
    <div className="grid gap-3">
      <div className="flex justify-end">
        <SegmentedControl
          label="Days of sellers online"
          options={OPTIONS}
          selected={count}
          onChange={setCount}
        />
      </div>
      <BarChartCard
        title="Average sellers online per day"
        kind="count"
        total={average}
        points={sellersOnlinePoints(shown)}
        startAtEnd
        summary={`Average of ${fullDays} full ${fullDays === 1 ? 'day' : 'days'}`}
      />
    </div>
  );
}
