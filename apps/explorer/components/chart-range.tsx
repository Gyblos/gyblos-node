'use client';

import { CalendarDays } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';

import { ALL_TIME, RANGE } from '../lib/constants';
import { rangeValue, type RangeDays } from '../lib/range';
import { Select } from './board/select';
import { useQueryNavigation } from './query-region';

const label = (days: RangeDays) =>
  days === ALL_TIME ? 'All' : days === 1 ? RANGE.dayParam : `${days}d`;
const options = RANGE.presets.map((days) => ({
  id: rangeValue(days),
  label: label(days),
}));

export function ChartRange({
  globalDays,
  override,
  onSelect,
}: {
  globalDays: RangeDays;
  override?: RangeDays;
  onSelect: () => void;
}) {
  const navigate = useQueryNavigation();
  const pathname = usePathname();
  const search = useSearchParams();

  return (
    <div className="flex items-center gap-2 text-muted">
      <Select
        size="sm"
        leadingIcon={
          <CalendarDays size={16} aria-hidden className="text-muted" />
        }
        label="Chart date range"
        selected={rangeValue(override ?? globalDays)}
        options={options}
        onChange={(next) => {
          const params = new URLSearchParams(search.toString());
          if (next === rangeValue(globalDays))
            params.delete(RANGE.sections.chart.param);
          else params.set(RANGE.sections.chart.param, next);
          const query = params.toString();
          onSelect();
          navigate(query ? `${pathname}?${query}` : pathname);
        }}
      />
    </div>
  );
}
