'use client';

import { Button, ButtonLink } from '@/components/base/buttons/button';
import { useTemplateCopy } from '@/components/foundations/template-copy/template-copy';
import { cx } from '@/utils/cx';
import { RiArrowLeftLine, RiArrowRightLine } from '@remixicon/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

export interface PaginationProps {
  page: number;
  totalPages: number;
  onChange?: (page: number) => void;
  hrefs?: Partial<Record<number, string>>;
  showPages?: boolean;
  dense?: boolean;
  siblingCount?: number;
  className?: string;
  previousLabel?: string;
  nextLabel?: string;
  'aria-label'?: string;
}
const DOTS = 'dots';
function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
function paginationRange(
  current: number,
  total: number,
  sibling: number,
): (number | typeof DOTS)[] {
  const totalPageNumbers = sibling * 2 + 5;
  if (totalPageNumbers >= total) return range(1, total);
  const leftSibling = Math.max(current - sibling, 1);
  const rightSibling = Math.min(current + sibling, total);
  const showLeftDots = leftSibling > 2;
  const showRightDots = rightSibling < total - 2;
  if (!showLeftDots && showRightDots) {
    return [...range(1, 3 + 2 * sibling), DOTS, total];
  }
  if (showLeftDots && !showRightDots) {
    return [1, DOTS, ...range(total - (2 + 2 * sibling), total)];
  }
  return [1, DOTS, ...range(leftSibling, rightSibling), DOTS, total];
}
const cell =
  'flex size-8 shrink-0 items-center justify-center rounded-lg text-body-medium';
const COMPACT_WIDTH = 420;
function useIsCompact() {
  const ref = useRef<HTMLElement>(null);
  const [isCompact, setIsCompact] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setIsCompact(entry.contentRect.width < COMPACT_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, isCompact] as const;
}
export function Pagination({
  page,
  totalPages,
  onChange,
  hrefs,
  showPages = true,
  dense = false,
  siblingCount = 1,
  className,
  previousLabel = 'Previous',
  nextLabel = 'Next',
  'aria-label': ariaLabel = 'Pagination',
}: PaginationProps) {
  const localize = useTemplateCopy();
  const [navRef, narrow] = useIsCompact();
  const isCompact = dense || narrow;
  const size = dense ? 'xs' : 'small';
  const pageCell = dense
    ? 'flex size-6 shrink-0 items-center justify-center rounded-md text-caption-1-medium'
    : cell;
  if (totalPages <= 1) return null;
  const pages = paginationRange(page, totalPages, isCompact ? 0 : siblingCount);
  const hrefOf = (target: number) => hrefs?.[target];
  const step = (
    target: number,
    available: boolean,
    label: string,
    icon: 'previous' | 'next',
  ) => {
    const href = hrefOf(target);
    const icons =
      icon === 'previous'
        ? { leadingIcon: RiArrowLeftLine }
        : isCompact
          ? { leadingIcon: RiArrowRightLine }
          : { trailingIcon: RiArrowRightLine };
    return available && href ? (
      <ButtonLink
        as={Link}
        href={href}
        variant="secondary"
        size={size}
        iconOnly={isCompact}
        aria-label={isCompact ? label : undefined}
        {...icons}
      >
        {isCompact ? undefined : label}
      </ButtonLink>
    ) : (
      <Button
        variant="secondary"
        size={size}
        iconOnly={isCompact}
        aria-label={isCompact ? label : undefined}
        disabled={!available}
        onClick={() => onChange?.(target)}
        {...icons}
      >
        {isCompact ? undefined : label}
      </Button>
    );
  };
  return localize(
    <nav
      ref={navRef}
      aria-label={ariaLabel}
      className={cx(
        dense
          ? 'inline-flex items-center gap-1'
          : 'flex w-full items-center justify-between gap-2',
        className,
      )}
    >
      {step(page - 1, page > 1, previousLabel, 'previous')}

      {showPages ? (
        <ul className="flex min-w-0 items-center gap-0.5">
          {pages.map((item, i) =>
            item === DOTS ? (
              <li
                key={`dots-${i}`}
                aria-hidden
                className={cx(pageCell, 'text-text-tertiary')}
              >
                …
              </li>
            ) : (
              <li key={item}>
                <PageCell
                  href={hrefOf(item)}
                  aria-label={`Go to page ${item}`}
                  aria-current={item === page ? 'page' : undefined}
                  onClick={() => onChange?.(item)}
                  className={cx(
                    pageCell,
                    'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-border-focus-ring',
                    item === page
                      ? 'border border-border-button-default bg-background-primary-default text-text-primary shadow-xs'
                      : 'text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary',
                  )}
                >
                  {item}
                </PageCell>
              </li>
            ),
          )}
        </ul>
      ) : null}

      {step(page + 1, page < totalPages, nextLabel, 'next')}
    </nav>,
  );
}

function PageCell({
  href,
  onClick,
  ...props
}: {
  href: string | undefined;
  onClick: () => void;
  className: string;
  children: number;
  'aria-label': string;
  'aria-current': 'page' | undefined;
}) {
  return href ? (
    <Link href={href} {...props} />
  ) : (
    <button type="button" onClick={onClick} {...props} />
  );
}
