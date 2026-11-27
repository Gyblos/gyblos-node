import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { previewStyles } from '../support/desktop-preview-styles';

const preview = new URL('../../lab/tools/desktop-preview/', import.meta.url);
const views = new URL('views/', preview);
const view = (name: string) => readFile(new URL(name, views), 'utf8');

void test('preview composer shows an inline spinner while the buyer balance is checked', async () => {
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /export function PreviewInlineSpinner\(/);
  assert.match(kit, /className="ui-inline-spinner"/);
  assert.match(kit, /checking = false/);
  assert.match(kit, /<PreviewInlineSpinner \/>/);
  assert.match(kit, /aria-busy=\{checking\}/);
  assert.match(kit, /Checking balance…/);
  assert.match(kit, /fundingAmount\(funding\.balanceAtomic\)/);
  assert.match(
    kit,
    /<span className="sr-only">Balance · last checked · <\/span>/,
  );
  const { CHAT_FUNDS_REWRITES } =
    await import('../../lab/tools/desktop-preview/funds-build');
  assert.ok(
    CHAT_FUNDS_REWRITES.some(([, to]) =>
      to.includes('checking={active && usingX402 && !!payer && loading}'),
    ),
  );
  assert.ok(
    CHAT_FUNDS_REWRITES.some(([, to]) => to.includes('funding={funding}')),
  );
  const constants = await readFile(new URL('constants.ts', preview), 'utf8');
  assert.match(
    constants,
    /PREVIEW_FUNDING = \{[\s\S]*READY: 'ready'[\s\S]*CHECKING: 'checking'[\s\S]*READY_ATOMIC: 2_000_000[\s\S]*ATOMIC_PER_USDC: 1_000_000/,
  );
  const funding = await readFile(new URL('funding.ts', preview), 'utf8');
  assert.match(funding, /PREVIEW_FUNDING\.CHECKING/);
  assert.match(funding, /PREVIEW_FUNDING\.READY/);
  assert.match(kit, /PREVIEW_FUNDING\.READY/);
  assert.match(kit, /PREVIEW_FUNDING\.READY_ATOMIC/);
  const css = await readFile('apps/desktop/src/ui/ui.css', 'utf8');
  assert.match(css, /\.ui-inline-spinner\s*\{/);
  assert.match(css, /display: inline-flex;/);
  assert.match(css, /animation: pk-spin 800ms linear infinite;/);
  assert.match(css, /@keyframes pk-spin/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ui-inline-spinner[\s\S]*animation: none;/,
  );
});

void test('preview chat model picker keeps funds actions compact and leaves the balance in the composer tab', async () => {
  const dropdown = await view('ModelDropdown.tsx.preview');
  assert.doesNotMatch(dropdown, /ModelMenuBalance/);
  assert.doesNotMatch(dropdown, /previewUsdc\(balance\)/);
  assert.match(dropdown, /className="preview-menu-actions"/);
  assert.match(dropdown, /label="Add funds"/);
  assert.match(dropdown, /label="View all models"/);
  assert.ok(
    dropdown.indexOf('label="Add funds"') <
      dropdown.indexOf('label="View all models"'),
  );
  const css = await previewStyles();
  assert.match(css, /\.preview-menu-actions\s*\{[^}]*display: flex/);
  assert.match(css, /\.preview-menu-actions \.dropdown-footer\s*\{/);
});
