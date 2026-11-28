// A headline figure, after BoardUI's stat cards (MIT, see ./LICENSE): a neutral card, a lighter icon tile,
// the label, the value with its change against the previous period (a free · paid pair carries one
// change per side, in the same order) and an optional line of context.
import type { ComponentType, ReactNode } from 'react';

import { StatHint } from '../../boardui/components/application/dashboard/stat-cards';
import { Chip } from './chip';
import { cx } from './cx';
import type { Delta } from './delta';
import { DeltaChip } from './delta-chip';

const SIDES = ['free', 'paid'] as const;
const LABEL = 'text-body-medium text-balance break-words text-text-secondary';
const VALUE = {
  footer:
    'max-w-full min-w-0 font-mono text-[clamp(1.125rem,calc(10cqi_+_0.1rem),1.75rem)] leading-tight tabular-nums',
  plain:
    'max-w-full min-w-0 font-mono text-[clamp(1rem,11cqi,1.375rem)] leading-tight tabular-nums',
} as const;

type Variant = keyof typeof VALUE;
type Sides = Record<(typeof SIDES)[number], ReactNode>;

function Pills({
  deltas,
  sides,
}: {
  deltas: (Delta | null)[];
  sides: boolean;
}) {
  const available = deltas.some(Boolean);
  return (
    <span
      data-loading-field=""
      className={cx(
        'flex items-start gap-1',
        sides
          ? 'min-h-[3.25rem] flex-col @min-[18rem]:min-h-6 @min-[18rem]:flex-row'
          : 'min-h-6',
      )}
    >
      {!available && <Chip>No baseline</Chip>}
      {available &&
        deltas.map((delta, index) =>
          delta ? (
            <DeltaChip
              key={index}
              delta={delta}
              side={sides ? SIDES[index] : undefined}
            />
          ) : (
            <Chip key={index}>
              {sides ? SIDES[index] + ' · ' : ''}No baseline
            </Chip>
          ),
        )}
    </span>
  );
}

function Value({
  variant,
  value,
  sides,
  money,
}: {
  variant: Variant;
  value?: ReactNode;
  sides?: Sides;
  money?: boolean;
}) {
  if (!sides)
    return (
      <span
        data-loading-field=""
        className={cx(
          VALUE[variant],
          money ? 'text-money' : 'text-text-primary',
        )}
      >
        {value}
      </span>
    );
  return (
    <span
      data-loading-field=""
      className="grid w-full min-w-0 auto-rows-[2rem] items-center gap-x-4 @min-[18rem]:flex @min-[18rem]:h-8"
    >
      {SIDES.map((side) => (
        <span key={side} className="inline-flex h-8 items-center gap-1">
          <span className={cx(VALUE[variant], 'text-text-primary')}>
            {sides[side]}
          </span>
          <span className="text-body-medium text-text-tertiary">{side}</span>
        </span>
      ))}
    </span>
  );
}

type CardProps = {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  value?: ReactNode;
  sides?: Sides;
  deltas?: (Delta | null)[];
  caption?: ReactNode;
  hint?: string;
  money?: boolean;
  variant?: Variant;
  comparison?: ReactNode;
  selection?: { pressed: boolean; controls: string; onPress: () => void };
};

function PlainCard({
  icon: Icon,
  label,
  selection,
  hint,
  value,
  sides,
  money,
  comparison,
  caption,
  changed,
}: CardProps & { changed: (Delta | null)[] | null }) {
  const frame =
    '@container row-span-3 grid min-w-0 grid-rows-subgrid gap-y-0 rounded-xl bg-background-secondary-default p-3';
  const content = (
    <>
      <span className="flex items-center gap-2">
        <span className="flex items-center rounded-md bg-stat-card-icon-background p-1.5 @max-[8rem]:hidden">
          <Icon
            aria-hidden
            className="size-4 shrink-0 text-foreground-icon-primary"
          />
        </span>
        <span
          className={cx(
            'min-w-0 flex-1 @max-[8rem]:text-caption-1-medium',
            LABEL,
          )}
        >
          {label}
        </span>
        {hint && !selection ? <StatHint label={label} hint={hint} /> : null}
      </span>
      <span
        className={cx(
          '@container mt-1 min-w-0',
          selection
            ? 'grid grid-rows-[2.25rem_1.75rem] items-center justify-items-start'
            : 'flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1',
        )}
      >
        <Value variant="plain" value={value} sides={sides} money={money} />
        {comparison}
      </span>
      {changed || caption ? (
        <span className="@container mt-1 flex min-w-0 flex-col gap-1 self-start">
          {changed ? <Pills deltas={changed} sides={!!sides} /> : null}
          {caption ? (
            <span className="text-caption-1-medium text-text-tertiary">
              {caption}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
  return selection ? (
    <button
      type="button"
      aria-controls={selection.controls}
      aria-pressed={selection.pressed}
      onClick={selection.onPress}
      className={cx(
        frame,
        'cursor-pointer text-left transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal',
        selection.pressed && 'ring-1 ring-inset ring-signal',
      )}
    >
      {content}
    </button>
  ) : (
    <section className={frame}>{content}</section>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  sides,
  deltas,
  caption,
  hint,
  money,
  variant = 'plain',
  selection,
  comparison,
}: CardProps) {
  const changed = deltas ?? null;
  if (variant === 'plain')
    return (
      <PlainCard
        icon={Icon}
        {...{
          label,
          selection,
          hint,
          value,
          sides,
          money,
          comparison,
          caption,
          changed,
        }}
      />
    );
  const band = caption;
  return (
    <section className="row-span-4 grid min-w-0 grid-rows-subgrid gap-y-0 rounded-xl bg-background-secondary-default p-2">
      <div className="flex w-full items-start justify-between gap-2.5 p-2">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2lg bg-stat-card-icon-background">
          <Icon
            aria-hidden
            className="size-5 shrink-0 text-foreground-icon-primary"
          />
        </span>
        {hint ? <StatHint label={label} hint={hint} /> : null}
      </div>
      <p className={cx('mx-2 mt-2.5', LABEL)}>{label}</p>
      <div className="@container mx-2 mt-0.5 mb-3.5 flex min-w-0 items-baseline self-baseline">
        <Value variant={variant} value={value} sides={sides} money={money} />
      </div>
      {band || changed ? (
        <div className="flex w-full flex-wrap items-center justify-between gap-2 self-end rounded-2lg bg-background-inner-default py-1.5 ps-2.5 pe-1.5 shadow-card">
          {band && (
            <p className="min-w-0 text-body-regular text-text-secondary">
              {band}
            </p>
          )}
          {changed ? <Pills deltas={changed} sides={!!sides} /> : null}
        </div>
      ) : null}
    </section>
  );
}
