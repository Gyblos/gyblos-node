// A figure's change against the previous period, after BoardUI's delta chip (MIT, see ./LICENSE): a
// tinted pill with a direction glyph. Good news reads green, bad news red, anything else neutral; the
// glyph and sign carry the direction, so color is never the only cue.
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { cx } from './cx';
import type { Delta } from './delta';

const TONES = {
  good: 'bg-good/15 text-good',
  bad: 'bg-bad/15 text-bad',
  neutral: 'bg-raised text-muted',
} as const;
const GLYPHS = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const;

export function DeltaChip({ delta }: { delta: Delta }) {
  const Glyph = GLYPHS[delta.direction];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-0.5 rounded-md py-0.5 pr-1.5 pl-1 font-mono text-xs whitespace-nowrap tabular-nums',
        TONES[delta.tone],
      )}
    >
      <Glyph aria-hidden className="size-3.5 shrink-0" />
      {delta.label}
    </span>
  );
}
