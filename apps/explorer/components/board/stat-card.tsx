// A headline figure, after BoardUI's stat cards (MIT, see ./LICENSE): a neutral card, a lighter icon tile,
// the label, the value with its change against the previous period (a free · paid pair carries one
// change per side, in the same order) or a share of a whole: a meter with a caption ("2 of 3 online").
import type { LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import { cx } from './cx';
import type { Delta } from './delta';
import { DeltaChip } from './delta-chip';
import { SURFACE } from './styles';

const PERCENT = 100;

export function StatCard({
  icon: Icon,
  label,
  value,
  deltas,
  share,
  caption,
  money,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  deltas?: Delta[];
  // The value as a part of a whole, drawn as a meter with its caption; only where the ratio says
  // something (a share of a meaningful whole), never for a one-of-one.
  share?: { part: number; whole: number; caption: ReactNode };
  // A plain line of context under the value, without a meter.
  caption?: ReactNode;
  money?: boolean;
}) {
  return (
    <section
      className={cx('flex min-w-0 flex-col gap-5 p-4 sm:p-5', SURFACE.card)}
    >
      <span
        className={cx(
          'flex size-9 items-center justify-center rounded-lg',
          SURFACE.inset,
        )}
      >
        <Icon aria-hidden className="size-4.5 text-ink" />
      </span>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted">{label}</span>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span
            className={cx(
              'font-mono text-2xl whitespace-nowrap text-ink',
              money && 'text-money',
            )}
          >
            {value}
          </span>
          {deltas?.length ? (
            <span className="flex items-center gap-1 text-xs text-dim">
              {deltas.map((change, index) => (
                <Fragment key={index}>
                  {index ? <span aria-hidden>·</span> : null}
                  <DeltaChip delta={change} />
                </Fragment>
              ))}
            </span>
          ) : null}
        </span>
        {share ? <Share {...share} /> : null}
        {caption ? <span className="text-xs text-muted">{caption}</span> : null}
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
        className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
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
