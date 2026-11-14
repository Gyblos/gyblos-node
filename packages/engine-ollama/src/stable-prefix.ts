// Certified only for the hash-pinned Qwen NFC/regex/ByteLevel tokenizer; not a generic BPE heuristic.
// The existing ASCII space fixes normalization, added-token scanning and the preceding regex piece.
import type { StableTokenPrefix } from '@gyblos/protocol/engine';

import { MODEL_LIMITS } from './constants';

export function qwenStablePrefix(
  count: (text: string) => number,
  text: string,
  targetTokens?: number,
): StableTokenPrefix {
  if (
    text.length > MODEL_LIMITS.maxOutputCharacters ||
    (targetTokens !== undefined &&
      (!Number.isSafeInteger(targetTokens) || targetTokens < 0))
  )
    throw new RangeError('Invalid stable prefix bounds.');
  const boundaries: number[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9] /g))
    boundaries.push(match.index + 1);
  if (!boundaries.length) return { characters: 0, tokens: 0 };
  let low = 0;
  let high = boundaries.length - 1;
  if (targetTokens !== undefined) {
    // Certified counts are monotone, so a large single engine fragment needs logarithmic recounts.
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (count(text.slice(0, boundaries[middle])) >= targetTokens)
        high = middle;
      else low = middle + 1;
    }
  } else low = high;
  const characters = boundaries[low]!;
  return { characters, tokens: count(text.slice(0, characters)) };
}
