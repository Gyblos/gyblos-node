'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { RANGE } from '../lib/constants';
import { sectionRangeHref } from '../lib/paging';
import type { RangeDays, RangeSection } from '../lib/range';
import { pagePath } from '../lib/seller-page';
import { SegmentedControl } from './board/segmented-control';

const OPTIONS = RANGE.presets.map((days) => ({
  value: days,
  label: `${days}d`,
}));

export function RangeControl({
  section,
  days,
}: {
  section: RangeSection;
  days: RangeDays;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  return (
    <div className={pending ? 'opacity-60 transition-opacity' : undefined}>
      <SegmentedControl
        label={`Date range for ${section}`}
        options={OPTIONS}
        selected={days}
        onChange={(next) =>
          startTransition(() =>
            router.push(
              sectionRangeHref(
                searchParams.toString(),
                section,
                next,
                pagePath(pathname),
              ),
              {
                scroll: false,
              },
            ),
          )
        }
      />
    </div>
  );
}
