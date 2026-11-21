import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
  assert.match(row, /marketMedian\(/);
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
  assert.match(settings, /Use a free model when out of funds/);
  assert.match(settings, /<Switch label="Use a free model when out of funds"/);
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
  assert.match(dropdown, /aria-label="Needs funds"/);
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
    transformBrand(await readFile(file, 'utf8'), file, 'apps/desktop') ?? '';
  assert.match(app, /import \{ usdPerMtok \} from '\.\/ui\/model-price';/);
});

void test('preview model rows keep one synthetic seller at the listed price', async () => {
  const row = await view('ModelRow.tsx.preview');
  assert.match(row, /const factor =\s*index === 0\s*\?\s*1\s*:/);
});

void test('preview free fallback lets the composer send instead of waiting for paid terms', async () => {
  const { CHAT_FUNDS_REWRITES } =
    await import('../../lab/tools/desktop-preview/funds-build');
  const canSend = CHAT_FUNDS_REWRITES.find(([from]) =>
    from.includes('const canSend'),
  )?.[1];
  assert.match(canSend ?? '', /\(previewFunds\.fallback \|\| !limitNotice\)/);
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
    transformBrand(await readFile(file, 'utf8'), file, 'apps/desktop') ?? '';
  assert.match(logo, /\{ file: 'codex-color' \}/);
  assert.match(logo, /\{ file: 'opencode-color' \}/);
  for (const name of ['tool-codex-color.svg', 'tool-opencode-color.svg'])
    assert.match(await readFile(new URL(name, preview), 'utf8'), /<svg/);
});
