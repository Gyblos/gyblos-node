'use client';

import { usePathname, useSearchParams } from 'next/navigation';

import { ALL_TIME, RANGE } from '../lib/constants';
import { sectionRangeHref } from '../lib/paging';
import type { RangeDays, RangeSection } from '../lib/range';
import { pagePath } from '../lib/seller-page';
import { SegmentedControl } from './board/segmented-control';
import { useQueryNavigation } from './query-region';

const OPTIONS = RANGE.presets.map((days) => ({
  value: days,
  label: days === ALL_TIME ? 'All' : days === 1 ? RANGE.dayParam : `${days}d`,
}));

export function RangeControl({
  section,
  days,
}: {
  section: RangeSection;
  days: RangeDays;
}) {
  const navigate = useQueryNavigation();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <SegmentedControl
      label={`Date range for ${section}`}
      options={OPTIONS}
      selected={days}
      onChange={(next) =>
        navigate(
          sectionRangeHref(
            searchParams.toString(),
            section,
            next,
            pagePath(pathname),
          ),
        )
      }
    />
  );
}
