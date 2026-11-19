// The change of a figure against the previous period of the same length, and whether that change is
// good news. Pure, no I/O; free and paid figures each get their own delta, never a combined one.
import { DELTA } from './constants';

// Which direction is good news for this figure; `none` for a change that is neither.
export type Better = 'up' | 'down' | 'none';
export type DeltaTone = 'good' | 'bad' | 'neutral';
export interface Delta {
  label: string;
  direction: 'up' | 'down' | 'flat';
  tone: DeltaTone;
}

const asNumber = (value: number | bigint) => Number(value);

export function delta(
  current: number | bigint,
  previous: number | bigint,
  better: Better = 'up',
): Delta {
  const now = asNumber(current);
  const before = asNumber(previous);
  if (now === before)
    return { label: '0%', direction: 'flat', tone: 'neutral' };
  const direction = now > before ? 'up' : 'down';
  const tone: DeltaTone =
    better === 'none' ? 'neutral' : direction === better ? 'good' : 'bad';
  if (before === 0) return { label: 'New', direction, tone };
  const change = ((now - before) / Math.abs(before)) * DELTA.percent;
  const size = Math.abs(change);
  const digits = size < DELTA.smallBelow ? DELTA.smallDigits : 0;
  return {
    label: `${change > 0 ? '+' : '-'}${size.toFixed(digits)}%`,
    direction,
    tone,
  };
}
