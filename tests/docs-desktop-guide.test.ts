// The desktop guide explains private automatic free startup without manual credentials.
// English and Spanish also identify the archive's actual wrapper directories.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const language of ['en', 'es']) {
  void test(`desktop guide ${language} describes automatic free startup and explicit privacy limits`, async () => {
    const suffix = language === 'es' ? '.es' : '';
    const text = await readFile(
      new URL(
        `../apps/docs/content/docs/buyers/desktop-app${suffix}.mdx`,
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(text, /userData/);
    assert.match(text, /without.*token|sin.*token/);
    assert.match(text, /zero|cero/);
    assert.match(text, /update|actualizaci/);
    assert.doesNotMatch(text, /Choose configuration folder|Choose GYBLOS_HOME/);
    assert.match(text, /Gyblos-darwin-arm64/);
    assert.match(text, /gyblos-desktop-win32-x64/);
  });
}
