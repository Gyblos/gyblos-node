'use client';

import { RiArrowLeftLine, RiArrowRightLine } from '@remixicon/react';
import Link from 'next/link';

import { cx } from '../../../utils/cx';
import { Button, ButtonLink } from '../buttons/button';

export interface PaginationProps {
  page: number;
  totalPages: number;
  hrefs: Partial<Record<number, string>>;
  showPages?: boolean;
  className?: string;
  previousLabel?: string;
  nextLabel?: string;
  'aria-label'?: string;
}
const DOTS = 'dots' as const;
const SLOTS = 5;
const EDGE = 3;
function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
function paginationRange(
  current: number,
  total: number,
): (number | typeof DOTS)[] {
  if (SLOTS >= total) return range(1, total);
  if (current < EDGE) return [...range(1, EDGE), DOTS, total];
  if (current > total - EDGE + 1)
    return [1, DOTS, ...range(total - EDGE + 1, total)];
  return [1, DOTS, current, DOTS, total];
}
const PAGE_CELL =
  'flex size-11 sm:pointer-fine:size-6 shrink-0 items-center justify-center rounded-md text-caption-1-medium';

function Step({
  href,
  label,
  next,
}: {
  href: string | undefined;
  label: string;
  next: boolean;
}) {
  const Icon = next ? RiArrowRightLine : RiArrowLeftLine;
  return href ? (
    <ButtonLink
      as={Link}
      href={href}
      variant="secondary"
      size="xs"
      iconOnly
      className="size-11 sm:pointer-fine:size-6"
      aria-label={label}
      leadingIcon={Icon}
    />
  ) : (
    <Button
      variant="secondary"
      size="xs"
      iconOnly
      className="size-11 sm:pointer-fine:size-6"
      aria-label={label}
      disabled
      leadingIcon={Icon}
    />
  );
}

export function Pagination({
  page,
  totalPages,
  hrefs,
  showPages = true,
  className,
  previousLabel = 'Previous',
  nextLabel = 'Next',
  'aria-label': ariaLabel = 'Pagination',
}: PaginationProps) {
  if (totalPages < 1) return null;
  return (
    <nav
      aria-label={ariaLabel}
      className={cx('inline-flex max-w-full items-center gap-1', className)}
    >
      <Step
        href={page > 1 ? hrefs[page - 1] : undefined}
        label={previousLabel}
        next={false}
      />
      {showPages ? (
        <ul className="flex min-w-0 flex-wrap items-center justify-center gap-0.5">
          {paginationRange(page, totalPages).map((item, i) =>
            item === DOTS ? (
              <li
                key={`dots-${i}`}
                aria-hidden
                className={cx(
                  PAGE_CELL,
                  'size-auto px-1 text-text-tertiary sm:pointer-fine:size-6 sm:px-0',
                )}
              >
                …
              </li>
            ) : (
              <li key={item}>
                <PageCell
                  href={hrefs[item]}
                  current={item === page}
                  page={item}
                />
              </li>
            ),
          )}
        </ul>
      ) : null}
      <Step
        href={page < totalPages ? hrefs[page + 1] : undefined}
        label={nextLabel}
        next
      />
    </nav>
  );
}

function PageCell({
  href,
  current,
  page,
}: {
  href: string | undefined;
  current: boolean;
  page: number;
}) {
  const className = cx(
    PAGE_CELL,
    'outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring',
    current
      ? 'border border-border-button-default bg-background-primary-default text-text-primary shadow-xs'
      : 'text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary',
  );
  return href && !current ? (
    <Link href={href} aria-label={`Go to page ${page}`} className={className}>
      {page}
    </Link>
  ) : (
    <span aria-current={current ? 'page' : undefined} className={className}>
      {page}
    </span>
  );
}
