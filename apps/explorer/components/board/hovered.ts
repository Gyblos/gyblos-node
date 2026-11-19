// Owns which bar a chart hover points at. Recharts reports the hovered index as a number, a numeric
// string, or null/undefined when the pointer is off the bars (on an axis or a margin); only a real index
// picks a point, so leaving the bars never shows the first day. Pure, no I/O.
const INDEX = /^\d+$/;

export function hoveredPoint<T>(
  points: readonly T[],
  index: number | string | null | undefined,
): T | null {
  const position =
    typeof index === 'number'
      ? index
      : typeof index === 'string' && INDEX.test(index)
        ? Number(index)
        : null;
  return position !== null && Number.isInteger(position)
    ? (points[position] ?? null)
    : null;
}
