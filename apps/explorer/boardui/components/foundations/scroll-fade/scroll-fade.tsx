'use client';

import { useCallback, useState, type UIEvent } from 'react';

import { cx } from '../../../utils/cx';

export const SCROLL_FADE_DISTANCE = 24;

export function useScrollFade(distance = SCROLL_FADE_DISTANCE) {
  const [progress, setProgress] = useState(0);
  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) =>
      setProgress(
        Math.min(1, Math.max(0, event.currentTarget.scrollTop) / distance),
      ),
    [distance],
  );
  const reset = useCallback(() => setProgress(0), []);
  return { progress, onScroll, reset };
}

export interface ScrollFadeProps {
  progress: number;

  surfaceClassName?: string;
  className?: string;
}

export function ScrollFade({
  progress,
  surfaceClassName = 'from-background-primary-default',
  className,
}: ScrollFadeProps) {
  return (
    <div
      aria-hidden
      className={cx(
        'pointer-events-none absolute inset-x-0 top-0 z-10 h-6',
        className,
      )}
    >
      <div
        className="absolute inset-0 backdrop-blur-[1px] [mask-image:linear-gradient(to_bottom,black,transparent)]"
        style={{ opacity: progress }}
      />
      <div
        className="absolute inset-x-0 top-0 h-4 backdrop-blur-[4px] [mask-image:linear-gradient(to_bottom,black,transparent)]"
        style={{ opacity: progress }}
      />
      <div
        className={cx(
          'absolute inset-0 bg-linear-to-b to-transparent',
          surfaceClassName,
        )}
        style={{ opacity: progress }}
      />
    </div>
  );
}
