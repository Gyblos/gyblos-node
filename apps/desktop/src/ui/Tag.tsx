import type { ReactNode } from 'react';

import { TONE, type Tone } from './status-tone';

export function Tag({
  tone = TONE.NEUTRAL,
  dot = false,
  pill = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pill?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="pk-tag" data-tone={tone} data-pill={pill || undefined}>
      {dot && <span className="pk-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
