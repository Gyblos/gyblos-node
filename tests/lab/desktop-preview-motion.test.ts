import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preview = new URL('../../lab/tools/desktop-preview/', import.meta.url);
const views = new URL('views/', preview);
const view = (name: string) => readFile(new URL(name, views), 'utf8');

void test('every preview dialog opens and closes with one shared motion and an origin option', async () => {
  const build = await readFile(new URL('brand-build.ts', preview), 'utf8');
  assert.match(
    build,
    /const MODAL_ORIGIN = \{\\n  CENTER: 'center',\\n  TOP: 'top',\\n  BOTTOM: 'bottom',\\n  LEFT: 'left',\\n  RIGHT: 'right',\\n\} as const;/,
  );
  assert.match(
    build,
    /export type ModalOrigin = \(typeof MODAL_ORIGIN\)\[keyof typeof MODAL_ORIGIN\];/,
  );
  assert.match(build, /origin\?: ModalOrigin;/);
  assert.match(build, /data-origin=\{origin \?\? MODAL_ORIGIN\.CENTER\}/);
  assert.equal(build.match(/'center'/g)?.length, 1);
  const css = await readFile(new URL('preview.css', preview), 'utf8');
  for (const origin of ['top', 'bottom', 'left', 'right'])
    assert.match(
      css,
      new RegExp(`dialog\\.modal\\[data-origin='${origin}'\\]`),
    );
  assert.match(css, /@keyframes pk-modal-in/);
  assert.match(css, /@keyframes pk-modal-out/);
  for (const name of [
    'Activity',
    'ModelDropdown',
    'ModelRow',
    'Payments',
    'Settings',
    'UsdcApiKeys',
    'X402Payments',
  ]) {
    const source = await view(`${name}.tsx.preview`);
    const opened =
      source.match(
        /\{[^{}]*&&\s*\(?\s*<(Modal|ActivitySessionDetails|RevokeConfirmation)\b/g,
      ) ?? [];
    const wrapped =
      source.match(
        /<MotionPresence>\s*\{[^{}]*&&\s*\(?\s*<(Modal|ActivitySessionDetails|RevokeConfirmation)\b/g,
      ) ?? [];
    assert.ok(opened.length > 0, `${name} opens a dialog`);
    assert.equal(
      wrapped.length,
      opened.length,
      `${name}: every dialog is inside MotionPresence`,
    );
  }
});

void test('model search Enter ignores IME composition and acts once across mounted pickers', async () => {
  const source = await view('ModelDropdown.tsx.preview');
  assert.match(source, /event\.isComposing/);
  assert.match(source, /event\.defaultPrevented/);
});

void test('shared amount fields live in the preview kit without import cycles or dead exports', async () => {
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /export function CompactAmount\(/);
  assert.match(kit, /export function AmountEditor\(/);
  assert.doesNotMatch(kit, /marketMedian/);
  const payments = await view('Payments.tsx.preview');
  assert.doesNotMatch(payments, /function (CompactAmount|AmountEditor)\(/);
  for (const name of ['X402Payments', 'UsdcApiKeys'])
    assert.doesNotMatch(
      await view(`${name}.tsx.preview`),
      /from '\.\/Payments'/,
    );
});
