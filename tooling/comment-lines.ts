export type CommentRange = { start: number; end: number };

export function lineEnd(text: string, index: number): number {
  const end = text.indexOf('\n', index);
  return end < 0 ? text.length : end;
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1)
    if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

export function lineIndex(starts: number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function physicalLineCount(
  text: string,
  ranges: CommentRange[],
): number {
  const starts = lineStarts(text);
  const lines = new Set<number>();
  for (const { start, end } of ranges) {
    let last = end - 1;
    while (last > start && /[\r\n]/.test(text[last] ?? '')) last -= 1;
    const final = lineIndex(starts, last);
    for (let line = lineIndex(starts, start); line <= final; line += 1)
      lines.add(line);
  }
  return lines.size;
}

export function addedComments(before: string[], after: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const comment of before)
    remaining.set(comment, (remaining.get(comment) ?? 0) + 1);
  return after.filter((comment) => {
    const count = remaining.get(comment) ?? 0;
    if (count === 0) return true;
    remaining.set(comment, count - 1);
    return false;
  });
}
