import {
  lineEnd,
  lineIndex,
  lineStarts,
  type CommentRange,
} from './comment-lines';

export function patchTargetText(text: string): {
  text: string;
  added: boolean[];
} {
  let inHunk = false;
  const added: boolean[] = [];
  const lines = text.split('\n').map((line) => {
    if (line.startsWith('@@')) inHunk = true;
    else if (line.startsWith('diff --git')) inHunk = false;
    const target = inHunk && (line.startsWith('+') || line.startsWith(' '));
    added.push(inHunk && line.startsWith('+'));
    return target ? ' ' + line.slice(1) : ' '.repeat(line.length);
  });
  return { text: lines.join('\n'), added };
}

export function patchCommentRanges(
  text: string,
  scan: (hunk: string) => CommentRange[],
): CommentRange[] {
  const target = patchTargetText(text);
  const starts = lineStarts(text);
  const ranges: CommentRange[] = [];
  let hunkStart = -1;
  for (let line = 0; line <= starts.length; line += 1) {
    const start = starts[line] ?? text.length;
    const boundary =
      line === starts.length ||
      text.startsWith('@@', start) ||
      text.startsWith('diff --git', start);
    if (!boundary) continue;
    if (hunkStart >= 0)
      for (const range of scan(target.text.slice(hunkStart, start)))
        ranges.push({
          start: range.start + hunkStart,
          end: range.end + hunkStart,
        });
    hunkStart = text.startsWith('@@', start) ? lineEnd(text, start) : -1;
  }
  return ranges.filter((range) => {
    const last = lineIndex(starts, Math.max(range.start, range.end - 1));
    for (let line = lineIndex(starts, range.start); line <= last; line += 1)
      if (target.added[line]) return true;
    return false;
  });
}
