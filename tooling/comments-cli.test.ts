import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addedComments,
  commentRanges,
  isSourceFile,
  physicalLineCount,
} from './comment-scanner';
import { commentBase } from './comments-cli';

void test('Python string prefixes keep embedded hashes inside the string', () => {
  for (const prefix of ['', 'r', 'b', 'f', 'fr']) {
    const text = 'value = ' + prefix + "'''text\n# inside\n'''\n# actual";
    assert.deepEqual(commentRanges(text, 'example.py'), [
      { start: text.indexOf('# actual'), end: text.length },
    ]);
  }
});

void test('PowerShell escaped quotes preserve following comments', () => {
  const text = '$value = "one `" two"\n# actual';
  assert.deepEqual(commentRanges(text, 'example.ps1'), [
    { start: text.indexOf('# actual'), end: text.length },
  ]);
});

void test('shell escaped quotes outside strings keep following comments', () => {
  const text = 'case "$x" in\n  *[\\"\\\'\\`]*) exit ;;\nesac\n# actual';
  assert.deepEqual(commentRanges(text, 'install.sh'), [
    { start: text.indexOf('# actual'), end: text.length },
  ]);
});

void test('shell heredoc bodies are data, not comments', () => {
  for (const opener of ["<<'EOF'", '<<EOF', '<<"EOF"', '<<-EOF']) {
    const text =
      'cat ' + opener + ' # actual one\n# data\nit\'s "open\nEOF\n# actual two';
    assert.deepEqual(commentRanges(text, 'install.sh'), [
      { start: text.indexOf('# actual one'), end: text.indexOf('\n') },
      { start: text.indexOf('# actual two'), end: text.length },
    ]);
  }
});

void test('shell here-strings are not heredocs', () => {
  const text = 'read -r x <<< "$y"\n# actual';
  assert.deepEqual(commentRanges(text, 'install.sh'), [
    { start: text.indexOf('# actual'), end: text.length },
  ]);
});

void test('desktop preview views are scanned as TSX', () => {
  const text = 'export const A = () => <div />; // actual';
  assert.equal(isSourceFile('lab/views/A.tsx.preview'), true);
  assert.deepEqual(commentRanges(text, 'lab/views/A.tsx.preview'), [
    { start: text.indexOf('// actual'), end: text.length },
  ]);
});

void test('dependency patches count comments on added lines only', () => {
  const text =
    'diff --git a/x.js b/x.js\n+++ b/x.js\n // context comment\n-// removed\n+const a = 1; // added\n+/** doc */\n';
  assert.equal(isSourceFile('patches/x@1.0.0.patch'), true);
  assert.deepEqual(
    commentRanges(text, 'patches/x@1.0.0.patch').map((range) =>
      text.slice(range.start, range.end),
    ),
    ['// added', '/** doc */'],
  );
});

void test('physical lines count each line once and ignore carriage returns', () => {
  const text = 'a /* one */ /* two */\r\n# three\r\nb';
  assert.equal(
    physicalLineCount(text, [
      { start: 2, end: 11 },
      { start: 12, end: 21 },
      { start: 23, end: 31 },
    ]),
    2,
  );
});

void test('replacing a comment counts as a new comment', () => {
  assert.deepEqual(
    addedComments(['// keep', '// old'], ['// keep', '// new']),
    ['// new'],
  );
  assert.deepEqual(addedComments(['// a', '// a'], ['// a', '// a']), []);
  assert.deepEqual(addedComments(['// a'], ['// a', '// a']), ['// a']);
});

void test('the comparison base falls back to upstream develop on forks', () => {
  const git = (refs: Record<string, string>) => (args: string[]) => {
    const sha = refs[args.at(-1) ?? ''];
    if (!sha) throw new Error('unknown ref');
    return sha + '\n';
  };
  assert.equal(commentBase({}, git({ 'origin/develop': 'a' })), 'a');
  assert.equal(commentBase({}, git({ 'upstream/develop': 'b' })), 'b');
  assert.equal(commentBase({ COMMENT_BASE_SHA: 'c' }, git({})), 'c');
  assert.throws(() => commentBase({}, git({})), /upstream\/develop/);
});
