// Verifies the published brand surface and local font delivery, independently of the React layout.
// Only public static export and checked-in kit checksums are read; no browser or external service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const OUTPUT = join(ROOT, 'out');

async function files(directory: string): Promise<string[]> {
  const nested = await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

void test('docs brand: both locales use official wordmarks and the new favicon', async () => {
  for (const locale of ['en', 'es']) {
    const html = await readFile(join(OUTPUT, `${locale}.html`), 'utf8');
    for (const variant of ['dark', 'light'])
      assert.ok(
        html.includes(`/brand/gyblos-wordmark-solid-${variant}.svg`),
        `${locale}: missing official ${variant} wordmark`,
      );
    assert.ok(html.includes('Gyblos'));
    assert.ok(html.includes('docs'));
    assert.doesNotMatch(html, /gyblos-mark-holographic|font-geist/);
  }
  const favicon = await readFile(join(OUTPUT, 'favicon.svg'), 'utf8');
  assert.ok(favicon.includes('#0a28f0'));
  assert.doesNotMatch(favicon, /<text\b/);
});

void test('docs brand: compiled styles deliver both typefaces with local font bytes', async () => {
  const exported = await files(OUTPUT);
  const styles = await Promise.all(
    exported
      .filter((path) => path.endsWith('.css'))
      .map((path) => readFile(path, 'utf8')),
  );
  const css = styles.join('\n');
  assert.match(css, /font-family:["']?Instrument Sans/);
  assert.match(css, /font-family:["']?JetBrains Mono/);
  assert.doesNotMatch(
    css,
    /fonts\.(?:googleapis|gstatic)\.com|font-family:["']?Geist(?:[;"']| Mono)/,
  );
  assert.match(css, /--brand-blue:\s*#0a28f0/);
  assert.doesNotMatch(css, /#(?:7dcef0|6cc6ec|0369a1)\b/i);
  const fonts = exported.filter((path) => /\.(?:ttf|woff2)$/.test(path));
  assert.ok(fonts.length >= 5, 'all five supplied font weights must ship');
  const hashes = await Promise.all(
    fonts.map(async (path) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ),
  );
  for (const source of [
    'InstrumentSans-Regular.ttf',
    'InstrumentSans-Medium.ttf',
    'InstrumentSans-Semibold.ttf',
    'JetBrainsMono-Regular.woff2',
    'JetBrainsMono-Medium.woff2',
  ]) {
    const expected = createHash('sha256')
      .update(await readFile(join(ROOT, 'app/brand', source)))
      .digest('hex');
    assert.ok(
      hashes.includes(expected),
      `${source}: missing or modified served font`,
    );
  }
});
