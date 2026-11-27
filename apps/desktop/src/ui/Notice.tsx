import { Info, Warning } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { TONE, type Tone } from './status-tone';

export function Notice({
  tone = TONE.WARNING,
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const Glyph = tone === TONE.WARNING || tone === TONE.DANGER ? Warning : Info;
  return (
    <p className="pk-notice" data-tone={tone} role="status">
      <Glyph size={15} weight="fill" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
