import assert from 'node:assert/strict';
import test from 'node:test';

import { commentRanges } from './comments-cli';

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
