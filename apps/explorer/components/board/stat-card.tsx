// A headline figure, after BoardUI's stat cards (MIT, see ./LICENSE): a gray card, a dark icon tile, the
// label, the value and either its change against the previous period (a free · paid pair carries one
// change per side, in the same order) or a share of a whole: a meter with a caption ("2 of 3 online").
import type { LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import { cx } from './cx';
import type { Delta } from './delta';
import { DeltaChip } from './delta-chip';

const PERCENT = 100;

export function StatCard({
  icon: Icon,
  label,
  value,
  deltas,
  share,
  money,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  deltas?: Delta[];
  // The value as a part of a whole, drawn as a meter with its caption.
  share?: { part: number; whole: number; caption: ReactNode };
  money?: boolean;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-2xl bg-raised p-4">
      <span className="flex size-9 items-center justify-center rounded-lg bg-bg">
        <Icon aria-hidden className="size-4.5 text-ink" />
      </span>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted">{label}</span>
        <span
          className={cx(
            'font-mono text-2xl whitespace-nowrap',
            money && 'text-money',
          )}
        >
          {value}
        </span>
        {deltas?.length ? (
          <span className="flex flex-wrap items-center gap-1 text-xs text-dim">
            {deltas.map((change, index) => (
              <Fragment key={index}>
                {index ? <span aria-hidden>·</span> : null}
                <DeltaChip delta={change} />
              </Fragment>
            ))}
          </span>
        ) : null}
        {share ? <Share {...share} /> : null}
      </div>
    </section>
  );
}

function Share({
  part,
  whole,
  caption,
}: {
  part: number;
  whole: number;
  caption: ReactNode;
}) {
  return (
    <span className="mt-1 flex flex-col gap-1.5">
      <span
        role="meter"
        aria-valuemin={0}
        aria-valuemax={whole}
        aria-valuenow={part}
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg"
      >
        <span
          className="block h-full rounded-full bg-signal"
          style={{ width: `${whole ? (part / whole) * PERCENT : 0}%` }}
        />
      </span>
      <span className="text-xs text-muted">{caption}</span>
    </span>
  );
}
