'use client';

import {
  RiArrowDownCircleFill,
  RiArrowUpCircleFill,
  RiIndeterminateCircleFill,
  RiInformationFill,
} from '@remixicon/react';
import { useState, type ComponentType } from 'react';
import { Focusable } from 'react-aria-components';

import { cx } from '../../../utils/cx';
import { Tooltip, TooltipTrigger } from '../../base/tooltip/tooltip';

type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;
export type DeltaColor = 'lime' | 'rose' | 'neutral';
const DELTA_STYLES: Record<
  DeltaColor,
  {
    icon: IconComponent;
    className: string;
    pill: string;
  }
> = {
  lime: {
    icon: RiArrowUpCircleFill,
    className: 'text-status-lime-text',
    pill: 'bg-status-lime-background',
  },
  rose: {
    icon: RiArrowDownCircleFill,
    className: 'text-status-rose-text',
    pill: 'bg-status-rose-background',
  },
  neutral: {
    icon: RiIndeterminateCircleFill,
    className: 'text-text-secondary',
    pill: 'bg-background-tertiary-default',
  },
};
const DIRECTION_ICONS = {
  up: RiArrowUpCircleFill,
  down: RiArrowDownCircleFill,
  flat: RiIndeterminateCircleFill,
} as const;
export function DeltaPill({
  delta,
  deltaColor,
  direction,
}: {
  delta: string;
  deltaColor: DeltaColor;
  direction?: keyof typeof DIRECTION_ICONS;
}) {
  const { className, pill } = DELTA_STYLES[deltaColor];
  const Icon = direction
    ? DIRECTION_ICONS[direction]
    : DELTA_STYLES[deltaColor].icon;
  return (
    <span
      className={cx(
        'flex shrink-0 items-center gap-1 rounded-full py-0.5 pe-2 ps-1',
        pill,
      )}
    >
      <Icon className={cx('size-4 shrink-0', className)} aria-hidden />
      <span
        className={cx(
          'text-body-medium whitespace-nowrap tabular-nums',
          className,
        )}
      >
        {delta}
      </span>
    </span>
  );
}
export function StatHint({ label, hint }: { label: string; hint: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipTrigger
      delay={200}
      shouldCloseOnPress={false}
      isOpen={open}
      onOpenChange={setOpen}
    >
      <Focusable>
        <button
          type="button"
          aria-label={`About ${label}`}
          onClick={() => setOpen((isOpen) => !isOpen)}
          className="flex size-11 shrink-0 cursor-pointer items-center sm:pointer-fine:size-auto justify-center rounded-full text-foreground-icon-secondary outline-none transition-colors duration-150 ease hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiInformationFill className="size-5" aria-hidden />
        </button>
      </Focusable>
      <Tooltip size="md">{hint}</Tooltip>
    </TooltipTrigger>
  );
}
