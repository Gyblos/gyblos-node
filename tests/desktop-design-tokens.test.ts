import assert from 'node:assert/strict';
import test from 'node:test';

import { BRAND_COLORS, themeStyle } from '@gyblos/desktop/theme';

import brand from '../lab/tools/desktop-preview/brand.json' with { type: 'json' };

void test('desktop uses the approved brand palette in both themes', () => {
  for (const [name, color] of Object.entries(brand.themeTokens)) {
    assert.equal(
      Object.entries(BRAND_COLORS).find(([key]) => key === name)?.[1],
      color,
      name,
    );
  }
  for (const light of [false, true]) {
    const theme = themeStyle(light);
    assert.equal(theme['--blue'], theme['--ink']);
    assert.equal(theme['--focus'], theme['--ink']);
  }
});
