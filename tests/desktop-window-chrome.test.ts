// Native control configuration is pure; no Electron process or platform APIs are started.
import assert from 'node:assert/strict';
import test from 'node:test';

import { windowChrome, windowPlatform } from '@gyblos/desktop/window-chrome';

void test('window chrome retains native controls and leaves startup windows unchanged', () => {
  assert.deepEqual(windowChrome('darwin'), {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
  });
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(windowChrome(platform), {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        height: 44,
        color: '#00000000',
        symbolColor: '#808080',
      },
    });
  }
  for (const platform of ['darwin', 'win32', 'linux', 'unknown', null]) {
    assert.deepEqual(windowChrome(platform, true), {});
  }
});
void test('renderer platform metadata is allowlisted and unknown hosts use the browser layout', () => {
  for (const platform of ['darwin', 'win32', 'linux', 'web'])
    assert.equal(windowPlatform(platform), platform);
  for (const platform of [undefined, null, {}, 'process', '/private/path']) {
    assert.equal(windowPlatform(platform), 'web');
    assert.deepEqual(windowChrome(platform), {});
  }
});
