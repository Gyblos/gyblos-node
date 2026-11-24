'use client';

import { CalendarDays } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { ALL_TIME, RANGE } from '../lib/constants';
import { rangeValue, type RangeDays } from '../lib/range';
import { cx } from './board/cx';
import { Select } from './board/select';

const FOLLOW = 'follow';
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
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pending, start] = useTransition();
  return (
    <div
      aria-busy={pending}
      className={cx(
        'flex items-center gap-2 text-muted',
        pending && 'opacity-60',
      )}
    >
      <Select
        leadingIcon={
          <CalendarDays size={16} aria-hidden className="text-muted" />
        }
        label="Chart date range"
        selected={override ? rangeValue(override) : FOLLOW}
        options={[
          { id: FOLLOW, label: `Overview · ${label(globalDays)}` },
          ...options,
        ]}
        onChange={(next) => {
          const params = new URLSearchParams(search.toString());
          if (next === FOLLOW) params.delete(RANGE.sections.chart.param);
          else params.set(RANGE.sections.chart.param, next);
          const query = params.toString();
          onSelect();
          start(() =>
            router.push(query ? `${pathname}?${query}` : pathname, {
              scroll: false,
            }),
          );
        }}
      />
    </div>
  );
}
