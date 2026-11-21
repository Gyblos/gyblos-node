import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

void test('preview dialogs share small, medium and large sizes that shrink with the window', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const file = 'apps/desktop/src/ui/Modal.tsx';
  const modal = transformBrand(
    await readFile(file, 'utf8'),
    file,
    'apps/desktop',
  );
  assert.match(modal ?? '', /size\?: 'sm' \| 'md' \| 'lg'/);
  assert.match(
    modal ?? '',
    /data-size=\{compact \? undefined : \(size \?\? 'md'\)\}/,
    'every dialog except compact pickers gets a size, medium by default',
  );
  const css = await readFile('lab/tools/desktop-preview/preview.css', 'utf8');
  for (const [size, width] of [
    ['sm', '440px'],
    ['md', '560px'],
    ['lg', '760px'],
  ] as const)
    assert.match(
      css,
      new RegExp(
        `\\.modal\\[data-size='${size}'\\] \\{\\s*--modal-width: ${width};`,
      ),
    );
  assert.match(
    css,
    /width: min\(var\(--modal-width\), calc\(100vw - 32px\)\);/,
  );
  assert.doesNotMatch(
    css,
    /width: min\(300px, calc\(100vw - 24px\)\)/,
    'system status uses the shared small size instead of its own 300px width',
  );
  const keys = await readFile(
    'lab/tools/desktop-preview/views/UsdcApiKeyDetails.tsx.preview',
    'utf8',
  );
  assert.match(keys, /<Modal title="Revoke API key\?" size="sm"/);
});

void test('metric cards explain their numbers with a help button and primary actions use high contrast', async () => {
  const card = await readFile(
    'lab/tools/desktop-preview/views/StatCard.tsx.preview',
    'utf8',
  );
  assert.match(card, /help\?: string;/);
  assert.match(
    card,
    /<IconButton\s+className="preview-info-tip"\s+label=\{'About ' \+ label\}\s+title=\{help\}/,
    'the help button is named after the metric and shows the explanation as its tooltip',
  );
  for (const view of ['Payments', 'ActivitySessions']) {
    const source = await readFile(
      `lab/tools/desktop-preview/views/${view}.tsx.preview`,
      'utf8',
    );
    const cards = source.match(/<StatCard\b[^>]*>/g) ?? [];
    assert.ok(cards.length >= 3, view + ' shows its metric cards');
    for (const tag of cards)
      assert.match(tag, /\bhelp=/, view + ' explains every metric: ' + tag);
  }
  const css = await readFile('lab/tools/desktop-preview/preview.css', 'utf8');
  assert.match(
    css,
    /\.ui-button--primary:not\(\.ui-icon-button\) \{\s*background: var\(--ink\);\s*color: var\(--panel\);/,
  );
});

void test('preview views use the shared dropdown instead of unstyled native selects', async () => {
  const { readdir } = await import('node:fs/promises');
  const dir = 'lab/tools/desktop-preview/views/';
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.preview')) continue;
    const source = await readFile(`${dir}${name}`, 'utf8');
    assert.doesNotMatch(source, /<select\b/, name);
  }
});
