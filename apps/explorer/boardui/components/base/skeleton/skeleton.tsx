'use client';

import type { CSSProperties, ReactNode } from 'react';

import { cx, sortCx } from '../../../utils/cx';

export type SkeletonShape = 'rect' | 'text' | 'circle';
const styles = sortCx({
  block: 'bui-skeleton block bg-text-primary/8',
  shape: {
    rect: 'rounded-xl',
    text: 'rounded-md',
    circle: 'rounded-full',
  },
});
const FADE =
  'transition-[opacity,filter] duration-300 ease-out motion-reduce:transition-none';
export interface SkeletonProps {
  shape?: SkeletonShape;
  isLoaded?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}
export function Skeleton({
  shape = 'rect',
  isLoaded = false,
  className,
  style,
  children,
}: SkeletonProps) {
  if (children === undefined) {
    return (
      <span
        aria-hidden
        className={cx(styles.block, 'relative', styles.shape[shape], className)}
        style={style}
      />
    );
  }
  return (
    <span className={cx('relative block', className)} style={style}>
      <span
        aria-hidden={!isLoaded || undefined}
        inert={!isLoaded}
        className={cx(
          'block',
          FADE,
          isLoaded
            ? 'opacity-100 blur-[0px]'
            : 'opacity-0 motion-safe:blur-[4px]',
        )}
      >
        {children}
      </span>
      <span
        aria-hidden
        className={cx(
          styles.block,
          styles.shape[shape],
          'pointer-events-none absolute inset-0',
          FADE,
          isLoaded && 'opacity-0',
        )}
      />
    </span>
  );
}
export interface SkeletonTextProps {
  lines?: number;
  lineClassName?: string;
  className?: string;
}
export function SkeletonText({
  lines = 3,
  lineClassName = 'h-3.5',
  className,
}: SkeletonTextProps) {
  return (
    <span aria-hidden className={cx('flex w-full flex-col gap-2.5', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          shape="text"
          className={cx(
            lineClassName,
            index === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full',
          )}
        />
      ))}
    </span>
  );
}
