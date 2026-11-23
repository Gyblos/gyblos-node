'use client';

// Owns the date range control in the header: a segmented control over the preset spans. A choice
// navigates to the same page with `?range=<days>`, so the server renders that range and the link can
// be shared.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { RANGE } from '../lib/constants';
import { rangeSwitchHref } from '../lib/paging';
import type { RangeDays } from '../lib/range';
import { pagePath } from '../lib/seller-page';
import { SegmentedControl } from './board/segmented-control';

const OPTIONS = RANGE.presets.map((days) => ({
  value: days,
  label: `${days}d`,
}));

export function RangeControl({ days }: { days: RangeDays }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  return (
    <div className={pending ? 'opacity-60 transition-opacity' : undefined}>
      <SegmentedControl
        label="Date range"
        options={OPTIONS}
        selected={days}
        onChange={(next) =>
          startTransition(() =>
            router.push(
              rangeSwitchHref(
                searchParams.toString(),
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
