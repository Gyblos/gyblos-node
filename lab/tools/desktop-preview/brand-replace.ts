// Exact-match source replacements for preview transforms; each fails loudly when the shipped source moves.

export function replaceOnce(source: string, before: string, after: string) {
  if (
    !source.includes(before) ||
    source.indexOf(before) !== source.lastIndexOf(before)
  )
    throw new Error(
      'Desktop brand review hook changed; update the preview explicitly.',
    );
  return source.replace(before, after);
}
// Replaces the source from the start marker up to (not including) the end marker, once.
export function replaceBetween(
  source: string,
  start: string,
  end: string,
  after: string,
) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || source.indexOf(start, from + 1) >= 0)
    throw new Error(
      'Desktop brand review hook changed; update the preview explicitly.',
    );
  return source.slice(0, from) + after + source.slice(to);
}
// Applies each replacement in order, each exactly once (replaceOnce).
export const replaceEach = (
  source: string,
  pairs: readonly [string, string][],
) =>
  pairs.reduce(
    (text, [before, after]) => replaceOnce(text, before, after),
    source,
  );
