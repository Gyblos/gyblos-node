import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DEVNET } from '@gyblos/config/network';

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

async function withPreviewGlobals<T>(
  search: string,
  atomic: number,
  run: () => Promise<T>,
): Promise<T> {
  const locationBefore = Object.getOwnPropertyDescriptor(
    globalThis,
    'location',
  );
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { search },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { previewFunds: { atomic, open: false } },
  });
  try {
    return await run();
  } finally {
    if (locationBefore)
      Object.defineProperty(globalThis, 'location', locationBefore);
    else Reflect.deleteProperty(globalThis, 'location');
    if (windowBefore) Object.defineProperty(globalThis, 'window', windowBefore);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

void test('preview funding follows the preview network', async () => {
  const [{ previewFunding }, { PREVIEW_FUNDING }] = await Promise.all([
    import('../../lab/tools/desktop-preview/funding'),
    import('../../lab/tools/desktop-preview/constants'),
  ]);
  const observe = (search: string) =>
    withPreviewGlobals(search, PREVIEW_FUNDING.READY_ATOMIC, () =>
      previewFunding('payer').balance(),
    );
  assert.equal(await observe('?funding=ready&testnet=hidden'), null);
  assert.equal(await observe('?funding=ready&network=mainnet'), null);
  const testnet = await observe('?funding=ready&network=testnet');
  assert.equal(testnet?.network, DEVNET);
  assert.equal(testnet?.balanceAtomic, String(PREVIEW_FUNDING.READY_ATOMIC));
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

void test('preview refreshes the observed balance after a simulated top-up and when the picker opens', async () => {
  const { CHAT_FUNDS_REWRITES } =
    await import('../../lab/tools/desktop-preview/funds-build');
  assert.ok(
    CHAT_FUNDS_REWRITES.some(([, to]) =>
      to.includes('refreshFunding={refresh}'),
    ),
  );
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /refreshFunding\?\(\): void/);
  assert.match(
    kit,
    /<PreviewFundsDialog[\s\S]*?refreshFunding=\{refreshFunding\}/,
  );
  const dialog = kit.slice(kit.indexOf('export function PreviewFundsDialog'));
  assert.match(dialog, /refreshFunding\?\.\(\)/);
  assert.ok(
    dialog.indexOf('refreshFunding?.()') <
      dialog.indexOf('Preview: simulate 2 USDC arriving'),
  );
  const dropdown = await view('ModelDropdown.tsx.preview');
  assert.match(dropdown, /refreshFunding\?\(\): void/);
  assert.match(dropdown, /onOpen=\{refreshFunding\}/);
});

void test('preview re-enabling testnet clears the hidden network flags', async () => {
  const settings = await view('Settings.tsx.preview');
  const choose = settings.slice(settings.indexOf('function chooseShowTestnet'));
  const functionEnd = choose.indexOf('window.dispatchEvent');
  const toggle = choose.slice(0, functionEnd);
  const showBranch = toggle.slice(0, toggle.indexOf('} else {'));
  const hideBranch = toggle.slice(toggle.indexOf('} else {'));
  assert.match(showBranch, /params\.delete\(PREVIEW_QUERY\.NETWORK\)/);
  assert.match(showBranch, /params\.delete\(PREVIEW_QUERY\.TESTNET\)/);
  assert.ok(
    choose.indexOf('params.delete(PREVIEW_QUERY.NETWORK)') <
      choose.indexOf('function BuyerPreferences'),
  );
  assert.match(
    hideBranch,
    /params\.set\(PREVIEW_QUERY\.NETWORK, PREVIEW_QUERY\.NETWORK_MAINNET\)/,
  );
  assert.match(
    hideBranch,
    /params\.set\(PREVIEW_QUERY\.TESTNET, PREVIEW_QUERY\.TESTNET_HIDDEN\)/,
  );
  assert.doesNotMatch(showBranch, /params\.set\(PREVIEW_QUERY/);
  assert.doesNotMatch(hideBranch, /params\.delete\(PREVIEW_QUERY/);
});
