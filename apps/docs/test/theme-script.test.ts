// Verifies the theme script props: the static HTML keeps the executable script that sets the theme before the
// first paint, and a client render (switching language re-renders the root layout) gets a data block that React
// does not warn about. Pure function; no browser.
import assert from 'node:assert/strict';
import test from 'node:test';

import { themeScriptProps } from '@gyblos/docs/theme-script';

void test('theme script stays executable in server output', () => {
  assert.equal(themeScriptProps(false), undefined);
});

void test('theme script is an inert data block when rendered on the client', () => {
  const props = themeScriptProps(true);
  assert.ok(props);
  assert.equal(typeof props.type, 'string');
  assert.doesNotMatch(String(props.type), /javascript|ecmascript|module/i);
});
