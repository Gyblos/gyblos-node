import { extname } from 'node:path';

import { parseForESLint } from '@typescript-eslint/parser';

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.dockerfile',
  '.headers',
  '.html',
  '.js',
  '.jsonc',
  '.jsx',
  '.mjs',
  '.patch',
  '.ps1',
  '.py',
  '.sh',
  '.shell',
  '.redirects',
  '.sql',
  '.svg',
  '.ts',
  '.tsx',
  '.toml',
  '.yaml',
  '.yml',
]);
const TYPESCRIPT_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);

export type CommentRange = { start: number; end: number };
type CommentOptions = {
  blockMarkers: { start: string; end: string }[];
  hashMarker?: string;
  adjacentHash?: boolean;
  powershell?: boolean;
  python?: boolean;
  shell?: boolean;
  yaml?: boolean;
  noQuotes?: boolean;
  singleQuoteEscapes?: boolean;
  lineMarkers: string[];
};
type Scanner = {
  text: string;
  options: CommentOptions;
  index: number;
  quote: string;
  quoteLength: number;
  heredocs: string[];
  ranges: CommentRange[];
};

const PREVIEW_SUFFIX = '.preview';
const SHELL_EXTENSIONS = new Set([
  '.dockerfile',
  '.sh',
  '.shell',
  '.yaml',
  '.yml',
]);
const TRIPLE_QUOTE = 3;
const HEREDOC_LOOKAHEAD = 256;
const HERE_STRING = '<<<';
const ARITHMETIC_OPEN = '((';
const ARITHMETIC_CLOSE = '))';
const SHELL_COMMENT_PREFIX = /[\s;|&(]/;
const POWERSHELL_HERE_STRING = /^@(['"])\r?\n/;
const HEREDOC = /^<<-?[ \t]*\\?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

function sourceExtension(path: string): string {
  const basename = path.split(/[\\/]/).at(-1) ?? '';
  if (['Dockerfile', 'Containerfile'].includes(basename)) return '.dockerfile';
  if (basename === '_headers') return '.headers';
  if (basename === '_redirects') return '.redirects';
  if (basename === 'gyblos') return '.shell';
  if (basename === '.env.example') return '.shell';
  if (basename.endsWith(PREVIEW_SUFFIX))
    return extname(basename.slice(0, -PREVIEW_SUFFIX.length)).toLowerCase();
  return extname(path).toLowerCase();
}

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(sourceExtension(path));
}

function typescriptCommentRanges(text: string, path: string): CommentRange[] {
  const { ast } = parseForESLint(text, {
    filePath: path.endsWith(PREVIEW_SUFFIX)
      ? path.slice(0, -PREVIEW_SUFFIX.length)
      : path,
    comment: true,
    range: true,
    jsx: true,
  });
  return (ast.comments ?? [])
    .filter(
      (comment) => text.slice(comment.range[0], comment.range[0] + 2) !== '#!',
    )
    .map((comment) => ({ start: comment.range[0], end: comment.range[1] }));
}

function lineEnd(text: string, index: number): number {
  const end = text.indexOf('\n', index);
  return end < 0 ? text.length : end;
}

function advanceInQuote(scanner: Scanner): void {
  const { text, options, quote, quoteLength } = scanner;
  const character = text[scanner.index];
  const escape = options.powershell
    ? quote === '"' && character === '`'
    : character === '\\' && (quote !== "'" || options.singleQuoteEscapes);
  if (escape) {
    scanner.index += 2;
    return;
  }
  const closes =
    character === quote &&
    (quoteLength === 1 ||
      text.slice(scanner.index, scanner.index + quoteLength) ===
        quote.repeat(quoteLength));
  if (options.yaml && character === '\n') {
    scanner.quote = '';
    return;
  }
  if (!closes) {
    scanner.index += 1;
    return;
  }
  if (quoteLength === 1 && quote === "'" && text[scanner.index + 1] === "'") {
    scanner.index += 2;
    return;
  }
  scanner.quote = '';
  scanner.index += quoteLength;
}

function skipPowershellHereString(scanner: Scanner): boolean {
  const { text, index } = scanner;
  const open = POWERSHELL_HERE_STRING.exec(
    text.slice(index, lineEnd(text, index) + 1),
  );
  if (!scanner.options.powershell || !open) return false;
  const closer = '\n' + (open[1] ?? '') + '@';
  const close = text.indexOf(closer, index);
  scanner.index = close < 0 ? index + 1 : close + closer.length;
  return true;
}

function opensQuote(scanner: Scanner): boolean {
  const { text, options, index } = scanner;
  const character = text[index] ?? '';
  if (options.noQuotes) return false;
  const opens =
    (character === "'" &&
      (options.python || !/[a-z0-9]/i.test(text[index - 1] ?? ''))) ||
    character === '"' ||
    (!options.powershell && !options.yaml && character === '`');
  if (!opens) return false;
  scanner.quote = character;
  scanner.quoteLength =
    character !== '`' &&
    text.slice(index, index + TRIPLE_QUOTE) === character.repeat(TRIPLE_QUOTE)
      ? TRIPLE_QUOTE
      : 1;
  scanner.index += scanner.quoteLength;
  return true;
}

function skipHeredocBodies(scanner: Scanner): void {
  const { text } = scanner;
  let index = scanner.index + 1;
  for (const tag of scanner.heredocs) {
    let found = false;
    while (!found && index < text.length) {
      const end = lineEnd(text, index);
      found = text.slice(index, end).trim() === tag;
      index = end + 1;
    }
    if (!found) index = scanner.index + 1;
  }
  scanner.heredocs = [];
  scanner.index = Math.min(index, text.length);
}

function shellSyntax(scanner: Scanner): boolean {
  if (!scanner.options.shell) return false;
  const { text, index } = scanner;
  if (text[index] === '\\') {
    scanner.index += 2;
    return true;
  }
  const arithmetic = text.startsWith(ARITHMETIC_OPEN, index)
    ? text.indexOf(ARITHMETIC_CLOSE, index + ARITHMETIC_OPEN.length)
    : -1;
  if (arithmetic >= 0 && arithmetic < lineEnd(text, index)) {
    scanner.index = arithmetic + ARITHMETIC_CLOSE.length;
    return true;
  }
  if (text.startsWith(HERE_STRING, index)) {
    scanner.index += HERE_STRING.length;
    return true;
  }
  const heredoc = HEREDOC.exec(text.slice(index, index + HEREDOC_LOOKAHEAD));
  if (heredoc) {
    scanner.heredocs.push(heredoc[2] ?? '');
    scanner.index += heredoc[0].length;
    return true;
  }
  if (text[index] !== '\n' || scanner.heredocs.length === 0) return false;
  skipHeredocBodies(scanner);
  return true;
}

function takeComment(scanner: Scanner): boolean {
  const { text, options, index } = scanner;
  const block = options.blockMarkers.find((marker) =>
    text.startsWith(marker.start, index),
  );
  if (block) {
    const close = text.indexOf(block.end, index + block.start.length);
    const end = close < 0 ? text.length : close + block.end.length;
    scanner.ranges.push({ start: index, end });
    scanner.index = end;
    return true;
  }
  const hash =
    options.hashMarker !== undefined &&
    text[index] === options.hashMarker &&
    (options.adjacentHash ||
      index === 0 ||
      (options.shell ? SHELL_COMMENT_PREFIX : /\s/).test(
        text[index - 1] ?? '',
      ));
  if (!hash && !options.lineMarkers.some((m) => text.startsWith(m, index)))
    return false;
  const end = lineEnd(text, index);
  scanner.ranges.push({ start: index, end });
  scanner.index = end;
  return true;
}

function delimitedCommentRanges(
  text: string,
  options: CommentOptions,
): CommentRange[] {
  const scanner: Scanner = {
    text,
    options,
    index: 0,
    quote: '',
    quoteLength: 1,
    heredocs: [],
    ranges: [],
  };
  while (scanner.index < text.length) {
    if (scanner.quote.length > 0) advanceInQuote(scanner);
    else if (
      !shellSyntax(scanner) &&
      !skipPowershellHereString(scanner) &&
      !opensQuote(scanner) &&
      !takeComment(scanner)
    )
      scanner.index += 1;
  }
  return scanner.ranges;
}

function addedPatchLines(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.startsWith('+') && !line.startsWith('+++ ')
        ? ' ' + line.slice(1)
        : ' '.repeat(line.length),
    )
    .join('\n');
}

export function commentRanges(text: string, path: string): CommentRange[] {
  const extension = sourceExtension(path);
  if (TYPESCRIPT_EXTENSIONS.has(extension))
    return typescriptCommentRanges(text, path);
  if (extension === '.patch')
    return delimitedCommentRanges(addedPatchLines(text), {
      singleQuoteEscapes: true,
      blockMarkers: [{ start: '/*', end: '*/' }],
      lineMarkers: ['//'],
    });
  if (extension === '.css')
    return delimitedCommentRanges(text, {
      blockMarkers: [{ start: '/*', end: '*/' }],
      lineMarkers: [],
    });
  if (extension === '.sql')
    return delimitedCommentRanges(text, {
      blockMarkers: [{ start: '/*', end: '*/' }],
      lineMarkers: ['--'],
    });
  if (extension === '.html' || extension === '.svg')
    return delimitedCommentRanges(text, {
      noQuotes: true,
      blockMarkers: [{ start: '<!--', end: '-->' }],
      lineMarkers: [],
    });
  if (extension === '.jsonc')
    return delimitedCommentRanges(text, {
      blockMarkers: [{ start: '/*', end: '*/' }],
      lineMarkers: ['//'],
    });
  if (extension === '.ps1')
    return delimitedCommentRanges(text, {
      powershell: true,
      blockMarkers: [{ start: '<#', end: '#>' }],
      hashMarker: '#',
      lineMarkers: [],
    });
  return delimitedCommentRanges(text, {
    blockMarkers: [],
    python: extension === '.py',
    singleQuoteEscapes: extension === '.py',
    yaml: extension === '.yaml' || extension === '.yml',
    shell: SHELL_EXTENSIONS.has(extension),
    adjacentHash: extension === '.py' || extension === '.toml',
    hashMarker: '#',
    lineMarkers: [],
  }).filter((range) => range.start !== 0 || !text.startsWith('#!'));
}

function lineIndex(starts: number[], position: number): number {
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
  const starts = [0];
  for (let index = 0; index < text.length; index += 1)
    if (text[index] === '\n') starts.push(index + 1);
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

export function commentTexts(text: string, path: string): string[] {
  return commentRanges(text, path).map((range) =>
    text.slice(range.start, range.end).replace(/\s+/g, ' ').trim(),
  );
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
