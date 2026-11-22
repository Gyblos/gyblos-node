import assert from 'node:assert/strict';
import test from 'node:test';

import { addedComments, physicalLineCount } from './comment-lines';
import { commentRanges, commentTexts, isSourceFile } from './comment-scanner';
import {
  changedSources,
  commentBase,
  renamedBaseComments,
} from './comments-cli';

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
    'diff --git a/x.js b/x.js\n+++ b/x.js\n@@ -1,2 +1,3 @@\n // context comment\n-// removed\n+const a = 1; // added\n+/** doc */\n';
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

void test('arithmetic shifts and unterminated heredocs hide no comments', () => {
  for (const text of ['x=$((a << b))\n# actual', 'echo shift <<B\n# actual'])
    assert.deepEqual(commentTexts(text, 'a.sh'), ['# actual']);
});

void test('backslash-quoted heredoc tags are heredocs', () => {
  assert.deepEqual(commentTexts('cat <<\\EOF\n# body\nEOF\n# actual', 'a.sh'), [
    '# actual',
  ]);
});

void test('renamed files compare old text with the old file type', () => {
  assert.deepEqual(
    renamedBaseComments('const a = <div />; // kept', 'x.tsx', 'x.ts'),
    ['// kept'],
  );
  assert.deepEqual(
    renamedBaseComments('# smuggled\necho hi', 'notes.txt', 'notes.sh'),
    [],
  );
});

void test('quoting edge cases hide no following comments', () => {
  const cases: [string, string][] = [
    ["$t = @'\nmachine's\n# data\n'@\n# actual", 'a.ps1'],
    ['echo hi;# actual', 'a.sh'],
    ['Write-Host hi;# actual', 'a.ps1'],
    ["echo 'C:\\'\n# actual", 'a.sh'],
    ["p: 'C:\\'\n# actual", 'a.yml'],
    ['body: use `x\n# actual', 'a.yml'],
    ["<em>Bob</em>'s\n<!-- actual -->", 'a.html'],
    ['((cd a) || true)\n# actual\nx=$(f $(g))', 'a.sh'],
    ['@@ -1 +1 @@\n+++i; // actual', 'x.patch'],
  ];
  for (const [text, path] of cases)
    assert.deepEqual(
      commentTexts(text, path).filter((comment) => comment.includes('actual')),
      [
        path === 'a.html'
          ? '<!-- actual -->'
          : text
              .slice(
                text.lastIndexOf(
                  text.includes('// actual') ? '// actual' : '# actual',
                ),
              )
              .split('\n')[0],
      ],
      path + ': ' + JSON.stringify(text),
    );
  assert.deepEqual(commentTexts("$t = @'\n# data\n'@", 'a.ps1'), []);
});

void test('forks prefer upstream develop over a stale origin develop', () => {
  const git = (args: string[]) =>
    ({ 'origin/develop': 'old\n', 'upstream/develop': 'new\n' })[
      args.at(-1) ?? ''
    ] ?? '';
  assert.equal(commentBase({}, git), 'new');
});

void test('heredoc delimiters use the whole word and bash whitespace rules', () => {
  assert.deepEqual(
    commentTexts('cat <<END-TEXT\nbody\nEND-TEXT\n# actual', 'a.sh'),
    ['# actual'],
  );
  assert.deepEqual(
    commentTexts('cat <<EOF\n  EOF\n# data\nEOF\n# actual', 'a.sh'),
    ['# actual'],
  );
  assert.deepEqual(
    commentTexts('cat <<-EOF\n# data\n\tEOF\n# actual', 'a.sh'),
    ['# actual'],
  );
  assert.deepEqual(
    commentTexts('run: |\n  cat <<EOF\n  # data\n  EOF\n  # actual', 'a.yml'),
    ['# actual'],
  );
});

void test('patch edits inside unchanged block comments are comments', () => {
  const before =
    '@@ -1,3 +1,3 @@\n /**\n- * old text\n+ * old text\n  */\n const a = 1;\n';
  const after =
    '@@ -1,3 +1,3 @@\n /**\n- * old text\n+ * new text\n  */\n const a = 1;\n';
  assert.equal(commentRanges(after, 'x.patch').length, 1);
  assert.deepEqual(
    addedComments(
      commentTexts(before, 'x.patch'),
      commentTexts(after, 'x.patch'),
    ),
    commentTexts(after, 'x.patch'),
  );
  assert.deepEqual(
    commentTexts('@@ -1 +1,2 @@\n // context only\n+const b = 2;\n', 'x.patch'),
    [],
  );
});

void test('untracked files are compared as new files', () => {
  const git = (args: string[]) =>
    args[0] === 'ls-files' ? 'scripts/new.sh\0' : 'M\0install.sh\0';
  assert.deepEqual(changedSources(git, 'base'), [
    ['install.sh', 'install.sh'],
    ['scripts/new.sh', undefined],
  ]);
});

void test('a block comment cut by a patch hunk ends with the hunk', () => {
  const text =
    '@@ -1 +1,2 @@\n /**\n+ * added\ndiff --git a/y.js b/y.js\n@@ -1 +1 @@\n+const c = 3; // next\n';
  assert.deepEqual(commentTexts(text, 'x.patch'), ['/** + * added', '// next']);
});

void test('YAML anchors, ANSI-C quotes and patch regex quotes', () => {
  assert.deepEqual(
    commentTexts('d: see [docs](#usage) and a?b=1&#frag\n# actual', 'a.yml'),
    ['# actual'],
  );
  assert.deepEqual(commentTexts("printf $'a\\'' # one\necho # two", 'a.sh'), [
    '# one',
    '# two',
  ]);
  assert.deepEqual(
    commentTexts(
      "@@ -1,3 +1,3 @@\n x.replace(/'/g, '');\n+y(); // in\n",
      'a.patch',
    ),
    ['// in'],
  );
});

void test('multi-line YAML strings and patch templates keep trailing comments', () => {
  assert.deepEqual(commentTexts('k: "one\n  two" # actual\n', 'a.yml'), [
    '# actual',
  ]);
  assert.deepEqual(
    commentTexts(
      '@@ -1 +1,4 @@\n x\n+const s = `\n+  select 1\n+`; // actual\n',
      'a.patch',
    ),
    ['// actual'],
  );
});
