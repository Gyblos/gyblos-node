import assert from 'node:assert/strict';
import test from 'node:test';

import { CODE_LANGUAGE, fenceLanguage } from '@gyblos/desktop/code-highlight';

void test('unrecognized code fence labels render as plain text', () => {
  for (const name of ['unknown', 'constructor', '__proto__']) {
    assert.equal(fenceLanguage('```' + name), CODE_LANGUAGE.TEXT);
  }
  assert.equal(fenceLanguage('```json'), CODE_LANGUAGE.JSON);
});
