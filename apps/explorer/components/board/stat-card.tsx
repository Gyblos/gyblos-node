// A headline figure, after BoardUI's stat cards (MIT, see ./LICENSE): a neutral card, a lighter icon tile,
// the label, the value with its change against the previous period (a free · paid pair carries one
// change per side, in the same order) and an optional line of context.
import type { LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import { cx } from './cx';
import type { Delta } from './delta';
import { DeltaChip } from './delta-chip';
import { SURFACE } from './styles';

export function StatCard({
  icon: Icon,
  label,
  value,
  deltas,
  caption,
  money,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  deltas?: Delta[];
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
              'max-w-full min-w-0 font-mono text-xl text-ink sm:text-2xl sm:whitespace-nowrap',
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
        {caption ? <span className="text-xs text-muted">{caption}</span> : null}
      </div>
    </section>
  );
}
