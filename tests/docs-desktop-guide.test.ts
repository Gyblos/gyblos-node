// The desktop guide states current buyer prerequisites instead of promising future onboarding.
// English and Spanish also identify the archive's actual wrapper directories.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const language of ['en', 'es']) {
  void test(`desktop guide ${language} distinguishes current setup from planned onboarding`, async () => {
    const suffix = language === 'es' ? '.es' : '';
    const text = await readFile(
      new URL(
        `../apps/docs/content/docs/buyers/desktop-app${suffix}.mdx`,
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(text, /buyer:init/);
    assert.match(text, /GYBLOS_HOME/);
    assert.match(text, /relay token|token de relay/);
    assert.match(text, /not yet|aún|todavía/);
    assert.doesNotMatch(
      text,
      /The app sets itself up the first time|La app se configura sola la primera vez/,
    );
    assert.match(text, /Gyblos-darwin-arm64/);
    assert.match(text, /gyblos-desktop-win32-x64/);
  });
}
