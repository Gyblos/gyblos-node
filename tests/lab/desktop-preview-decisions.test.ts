import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { previewStyles } from '../support/desktop-preview-styles';

const preview = new URL('../../lab/tools/desktop-preview/', import.meta.url);
const views = new URL('views/', preview);
const view = (name: string) => readFile(new URL(name, views), 'utf8');

void test('preview shows listed prices as they are, since they already include the protocol fee', async () => {
  const { PROTOCOL_FEE } = await import('@gyblos/config/network');
  const { feeLabel } = await import('../../lab/tools/desktop-preview/market');
  assert.equal(feeLabel, `incl. ${PROTOCOL_FEE.bps / 100}% fee`);
  const constants = await readFile(new URL('constants.ts', preview), 'utf8');
  assert.doesNotMatch(constants, /FeeBps/);
  for (const name of ['ModelRow.tsx.preview', 'ModelDropdown.tsx.preview']) {
    const source = await view(name);
    assert.doesNotMatch(source, /buyerPerMtok|buyerTotal/, name);
    assert.match(source, /usdPerMtok\(/, name);
  }
});

void test('preview market reference is the median of at least three offers', async () => {
  const { marketMedian } =
    await import('../../lab/tools/desktop-preview/market');
  assert.equal(marketMedian([0.1, 0.2]), null);
  assert.equal(marketMedian([0.3, 0.1, 0.2]), 0.2);
  assert.equal(marketMedian([0.1, 0.2, 0.3, 0.4]), 0.25);
});

void test('preview suggests the closest free model by family, then size', async () => {
  const { similarFreeModel } =
    await import('../../lab/tools/desktop-preview/market');
  const models = [
    { id: 'llama', name: 'Llama 3.2 3B', free: true },
    { id: 'qwen-small', name: 'Qwen3 0.6B', free: true },
    { id: 'qwen-mid', name: 'Qwen3 8B', free: true },
    { id: 'qwen-paid', name: 'Qwen3 14B', free: false },
  ];
  assert.equal(similarFreeModel(models, 'Qwen3 30B')?.id, 'qwen-mid');
  assert.equal(similarFreeModel(models, 'Gemma 3 4B')?.id, 'llama');
  assert.equal(similarFreeModel([], 'Qwen3 30B'), undefined);
  const unsized = [
    { id: 'alpha', name: 'Alpha', free: true },
    { id: 'beta', name: 'Beta', free: true },
  ];
  assert.equal(similarFreeModel(unsized, 'Mystery')?.id, 'alpha');
});

void test('preview spending limit starts unset and zero allows free models only', async () => {
  const { accountBudgetSnapshot } =
    await import('../../lab/tools/desktop-preview/account-budget');
  assert.equal(accountBudgetSnapshot('0', [], false).limited, false);
  const host = await readFile(new URL('host.ts', preview), 'utf8');
  assert.match(
    host,
    /let limited = limitQuery === 'set' \|\| limitQuery === '0';/,
  );
  assert.match(
    host,
    /let limitAtomic = limitQuery === '0' \? '0' : '1000000';/,
  );
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /const limited = account\.limited;/);
  assert.match(kit, /Free models only/);
});

void test('preview model views compare listed prices with the market median, not synthetic list prices', async () => {
  const row = await view('ModelRow.tsx.preview');
  assert.doesNotMatch(row, /function listPrice/);
  assert.match(row, /comparableMedian\(sellers, cheapest\)/);
  assert.match(row, /'from ' \+ usdPerMtok\(cheapest\?\.input \?\? min\)/);
});

void test('preview API keys follow the account-wide free-model fallback, with no per-key choice', async () => {
  const details = await view('UsdcApiKeyDetails.tsx.preview');
  assert.doesNotMatch(
    details,
    /Fallback model|FallbackModel|previewFreeModels/,
  );
  assert.match(details, /usePreviewSetting\('freeFallback'\)/);
  assert.match(details, /PREVIEW_COPY\.keyOutOfFunds/);
  assert.match(await view('UsdcApiKeys.tsx.preview'), /<KeyFallback \/>/);
  const settings = await view('Settings.tsx.preview');
  assert.match(settings, /<Switch label=\{PREVIEW_COPY\.freeFallbackLabel\}/);
  assert.match(
    await view('PreviewKit.tsx.preview'),
    /freeFallbackLabel: 'Use a free model when out of funds'/,
  );
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /similarFreeModel\(/);
  assert.match(kit, /fallback: broke && fallback && !!free/);
});

void test('preview shows four seller modes with Fastest and Most reliable marked Soon', async () => {
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(
    kit,
    /SELLER_MODES = \['Auto', 'Cheapest', 'Fastest', 'Most reliable'\] as const/,
  );
  assert.match(
    kit,
    /READY_SELLER_MODES: readonly SellerMode\[\] = \['Auto', 'Cheapest'\]/,
  );
  for (const name of [
    'ModelRow.tsx.preview',
    'ModelDropdown.tsx.preview',
    'Settings.tsx.preview',
  ]) {
    const source = await view(name);
    assert.match(source, /<Tag>Soon<\/Tag>/, name);
    assert.match(source, /READY(_SELLER_MODES)?\.includes\(/, name);
  }
});

void test('preview keeps a pinned seller first and announces its replacement when it is unavailable', async () => {
  const row = await view('ModelRow.tsx.preview');
  assert.match(row, /update\(\{ strategy, pinned: choice\.pinned \}\)/);
  assert.doesNotMatch(row, /update\(\{ strategy[^}]*pinned: null \}\)/);
  assert.match(row, /PREVIEW_COPY\.pinnedUnavailable\(/);
  assert.match(row, /PREVIEW_COPY\.pinnedNoReplacement\(/);
  assert.match(row, /sellers\.filter\(\(s\) => s\.online\)/);
});

void test('preview disables paid-only models without funds unless the free fallback is on', async () => {
  const dropdown = await view('ModelDropdown.tsx.preview');
  assert.match(
    dropdown,
    /broke && !fallback && !list\.some\(\(item\) => item\.free\)/,
  );
  assert.match(dropdown, /disabled=\{locked\}/);
  assert.match(
    dropdown,
    /title=\{locked \? PREVIEW_COPY\.needsFunds : undefined\}/,
  );
});

void test('preview composer shows an inline spinner while the buyer balance is checked', async () => {
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /export function PreviewInlineSpinner\(/);
  assert.match(kit, /checking = false/);
  assert.match(kit, /<PreviewInlineSpinner \/>/);
  assert.match(kit, /aria-busy=\{checking\}/);
  assert.match(kit, /Checking balance…/);
  const { CHAT_FUNDS_REWRITES } =
    await import('../../lab/tools/desktop-preview/funds-build');
  assert.ok(
    CHAT_FUNDS_REWRITES.some(([, to]) => to.includes('checking={loading}')),
  );
  const funding = await readFile(new URL('funding.ts', preview), 'utf8');
  assert.match(funding, /funding'\) === 'checking'/);
  const css = await previewStyles();
  assert.match(css, /\.pk-inline-spinner\s*\{/);
  assert.match(css, /animation: pk-spin 800ms linear infinite;/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.pk-inline-spinner[\s\S]*animation: none;/,
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

void test('preview hides Testnet behind a developer setting', async () => {
  const network = await view('NetworkSwitch.tsx.preview');
  assert.match(network, /usePreviewSetting\('showTestnet'\)/);
  assert.doesNotMatch(network, /until Dec 9|turned off on December 9/);
  const settings = await view('Settings.tsx.preview');
  assert.match(settings, /<Switch label="Show Testnet"/);
  assert.match(settings, /~\/\.gyblos\/buyer\/config\.toml/);
});

void test('preview paid-model confirmation formats the same listed prices as the picker', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const file = 'apps/desktop/src/desktop-app.tsx';
  const app =
    transformBrand(await readFile(file, 'utf8'), file, 'apps/desktop') ??
    (await readFile(file, 'utf8'));
  assert.match(app, /import \{ usdPerMtok \} from '\.\/ui\/model-price';/);
});

void test('preview Models screen keeps one selectable row per model', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const file = 'apps/desktop/src/ui/Models.tsx';
  const models =
    transformBrand(await readFile(file, 'utf8'), file, 'apps/desktop') ??
    (await readFile(file, 'utf8'));
  assert.doesNotMatch(models, /<NetworkSellerMenu/);
  assert.match(models, /<PreviewCatalog[^>]*canSelect=\{canSelect\}/);
  assert.doesNotMatch(models, /canSelect=\{false\}/);
});

void test('preview model rows keep one synthetic seller at the listed price', async () => {
  const row = await view('ModelRow.tsx.preview');
  assert.match(row, /const factor =\s*index === 0\s*\?\s*1\s*:/);
});

void test('preview menu arrow keys skip disabled options', async () => {
  const dropdown = await view('ModelDropdown.tsx.preview');
  assert.match(dropdown, /filter\(\(item\) => !item\.matches\(':disabled'\)\)/);
});

void test('preview buyer config block uses the default copy that confirms success', async () => {
  const settings = await view('Settings.tsx.preview');
  assert.doesNotMatch(settings, /onCopy=\{\(\) => navigator\.clipboard/);
});

void test('preview title bar and composer read the same network after the Testnet switch changes', async () => {
  const network = await view('NetworkSwitch.tsx.preview');
  assert.match(network, /const network = usePreviewNetwork\(\);/);
  assert.doesNotMatch(network, /usePreviewState/);
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /export function usePreviewNetwork\(\)/);
  assert.match(kit, /const network = usePreviewNetwork\(\);/);
});

void test('preview free fallback applies only when a free model exists', async () => {
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /const free = models\.find/);
  assert.match(kit, /blocked: broke && !\(fallback && free\)/);
  const { CHAT_FUNDS_REWRITES } =
    await import('../../lab/tools/desktop-preview/funds-build');
  assert.ok(
    CHAT_FUNDS_REWRITES.some(([, to]) =>
      to.includes('usePreviewFunds(model, !usingPaypal, models)'),
    ),
  );
});

void test('preview settings read review states from the URL and write them to the buyer config sample', async () => {
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /freeFallback: query\.get\('fallback'\) === 'on'/);
  assert.match(kit, /showTestnet: query\.get\('testnet'\) !== 'hidden'/);
  assert.match(kit, /PREVIEW_COPY\.fallbackNext\(free\.name\)/);
  const settings = await view('Settings.tsx.preview');
  for (const key of ['show_testnet = ', 'free_fallback = ', 'mode = "'])
    assert.ok(settings.includes(key), key);
  const row = await view('ModelRow.tsx.preview');
  assert.match(row, /const index = READY\.indexOf\(choice\.strategy\);/);
});

void test('preview shows the color marks of OpenCode and Codex', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const file = 'apps/desktop/src/ui/ServiceLogo.tsx';
  const logo =
    transformBrand(await readFile(file, 'utf8'), file, 'apps/desktop') ??
    (await readFile(file, 'utf8'));
  assert.match(logo, /\{ file: 'codex-color' \}/);
  assert.match(logo, /\{ file: 'opencode-color' \}/);
  for (const name of ['codex-color.svg', 'opencode-color.svg'])
    assert.match(
      await readFile('apps/desktop/public/assets/tools/' + name, 'utf8'),
      /<svg/,
    );
});

void test('preview free fallback never bypasses unfinished payments, expired listings or the wrong free listing', async () => {
  const { CHAT_FUNDS_REWRITES } =
    await import('../../lab/tools/desktop-preview/funds-build');
  const canSend =
    CHAT_FUNDS_REWRITES.find(([from]) => from.includes('const canSend'))?.[1] ??
    '';
  assert.match(canSend, /x402\?\.state\.summary\.blocked/);
  assert.match(canSend, /freeListingMismatch/);
  assert.match(
    canSend,
    /\(previewFunds\.fallback \? !previewHardNotice : !limitNotice\)/,
  );
});

void test('preview switch geometry uses the shared radius tokens', async () => {
  const css = await previewStyles();
  const rules = css.slice(css.indexOf('/* Switch: global on/off setting. */'));
  assert.doesNotMatch(
    rules.slice(0, rules.indexOf('/* Seller modes')),
    /border-radius: (999px|50%)/,
  );
});

void test('preview menus, number fields and model rows follow the shared component recipe', async () => {
  const css = await previewStyles();
  assert.match(css, /--pk-menu-motion: 150ms/);
  assert.match(css, /scale: 0\.95;\n\s*filter: blur\(2px\);/);
  assert.match(
    css,
    /\.pk-tag\[data-pill\] \{\n\s*border-radius: var\(--radius-badge\);/,
  );
  const amounts = await view('PreviewKit.tsx.preview');
  assert.equal(
    amounts.match(/<span className="preview-steppers">/g)?.length,
    2,
  );
  const dropdown = await view('ModelDropdown.tsx.preview');
  assert.match(dropdown, /<ModelMenuBadges offers=\{list\}/);
  const desktop = await readFile(
    'apps/desktop/src/ui/ModelDropdown.tsx',
    'utf8',
  );
  for (const picker of [desktop, dropdown])
    assert.match(picker, /<ModelMenuBalance/);
  const balance = await readFile(
    'apps/desktop/src/ui/ModelMenuBalance.tsx',
    'utf8',
  );
  assert.match(balance, /<span>Balance<\/span>/);
  assert.match(balance, /className="pk-balance-add"/);
});

void test('model picker lets Paid speak for itself and sizes the seller flyout to its content', async () => {
  const dropdown = await view('ModelDropdown.tsx.preview');
  assert.doesNotMatch(dropdown, /pk-needs-funds/);
  assert.doesNotMatch(dropdown, /panel\.style\.height = box\.height/);
  const css = await previewStyles();
  assert.match(
    css,
    /\.preview-model-list \.dropdown-copy strong \{\n\s*font-size: 14px;/,
  );
  assert.doesNotMatch(css, /\.pk-balance-line\[data-empty\] > svg/);
});

void test('model picker announces Needs funds only on rows that are actually disabled', async () => {
  const dropdown = await view('ModelDropdown.tsx.preview');
  assert.match(dropdown, /<ModelMenuBadges [^>]+locked=\{locked\} \/>/);
  assert.match(
    dropdown,
    /title=\{\s*soon\s*\? PREVIEW_COPY\.sellerModeSoon\s*: locked\s*\? PREVIEW_COPY\.needsFunds\s*: detail\s*\}/,
  );
});

void test('preview stylesheet declares each picker and flyout rule once, on shared tokens', async () => {
  const css = await previewStyles();
  for (const selector of [
    'html .app.desktop-frame .compact-dropdown .dropdown-row {',
    'html .app.desktop-frame .compact-dropdown .dropdown-row[data-strategy] {',
    'html .app.desktop-frame .preview-strategy-icon {',
    'html .app.desktop-frame .preview-flyout-title {',
    'html .app.desktop-frame .pk-balance-line {',
    'html .app.desktop-frame .pk-balance-line strong {',
    'html .app.desktop-frame .preview-model-list .ui-item-title {',
  ]) {
    assert.equal(css.split('\n' + selector).length - 1, 1, selector);
  }
  assert.match(
    css,
    /\.desktop-frame \{[^}]*--pk-radius-tag: 6px;[^}]*--pk-menu-motion: 150ms;/,
  );
  assert.doesNotMatch(
    css,
    /border-radius: [0-9]+px;\n[^}]*\}\nhtml \.app\.desktop-frame \.preview-strategy-icon/,
  );
  assert.doesNotMatch(css, /rotate 200ms/);
});

void test('preview median counts only online offers at the same quantization (option B)', async () => {
  const { comparableMedian } =
    await import('../../lab/tools/desktop-preview/market');
  const offer = (input: number, quant: string, online = true) => ({
    input,
    quant,
    online,
  });
  const cheapest = offer(0.1, 'Q4_K_M');
  const offers = [
    cheapest,
    offer(0.2, 'Q4_K_M'),
    offer(0.3, 'Q8_0'),
    offer(0.4, 'FP16'),
  ];
  assert.equal(comparableMedian(offers, cheapest), null);
  assert.equal(
    comparableMedian([...offers, offer(0.5, 'Q4_K_M', false)], cheapest),
    null,
  );
  assert.equal(
    comparableMedian([...offers, offer(0.3, 'Q4_K_M')], cheapest),
    0.2,
  );
});

void test('closed seller flyout takes no room, so a short model menu needs no scrollbar', async () => {
  const css = await previewStyles();
  const rule =
    /html \.app\.desktop-frame \.compact-dropdown\.preview-seller-flyout(:popover-open)? \{\n  display: flex;/.exec(
      css,
    );
  assert.ok(rule, 'flyout layout rule');
  assert.equal(rule[1], ':popover-open');
});

void test('preview overlays follow the BoardUI recipe: turning carets, popover tooltips, combobox Enter', async () => {
  const css = await previewStyles();
  assert.match(
    css,
    /@media \(prefers-reduced-motion: no-preference\) \{\n\s*html\n\s*body\n\s*\.app\.desktop-frame\n\s*\[aria-expanded\]\n\s*> :is\(\.preview-trigger-caret, svg:last-child:not\(:only-child\)\) \{\n\s*transition: rotate var\(--pk-menu-motion\) ease-out !important;/,
  );
  assert.match(
    css,
    /\.ui-select-trigger\[aria-expanded='true'\]::after \{\n\s*rotate: 225deg;/,
  );
  assert.match(
    css,
    /html \.app\.desktop-frame \.ui-tooltip \{\n\s*translate: none;\n\s*scale: 0\.95;\n\s*filter: blur\(2px\);/,
  );
  assert.doesNotMatch(css, /\.ui-tooltip \{\n\s*transition-duration: 80ms;/);
  const dropdown = await view('ModelDropdown.tsx.preview');
  assert.match(dropdown, /\[data-model-row\]:not\(:disabled\)/);
  assert.match(css, /:nth-child\(1 of \[data-model-row\]:not\(:disabled\)\)/);
});

void test('account spending limit form uses the shared number field', async () => {
  const x402 = await view('X402Payments.tsx.preview');
  assert.match(x402, /<CompactAmount id="account-budget"/);
  assert.doesNotMatch(x402, /<FormInput id="account-budget"/);
});
