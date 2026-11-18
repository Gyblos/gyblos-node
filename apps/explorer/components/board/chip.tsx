// A small label chip, after BoardUI's Chip (MIT, see ./LICENSE), re-tinted to the Gyblos neutrals: the
// brand tone marks a state (online), the neutral one a plain tag. No colors beyond the identity.
import type { ReactNode } from 'react';

import { cx } from './cx';

const TONES = {
  neutral: 'bg-raised text-muted',
  brand: 'bg-signal/15 text-ink',
} as const;

export function Chip({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-xs whitespace-nowrap',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
