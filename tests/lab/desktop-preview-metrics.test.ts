import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { previewStyles } from '../support/desktop-preview-styles';

void test('Payments uses a single history table for both sources', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const view = async (name: string) => {
    const file = 'apps/desktop/src/ui/' + name + '.tsx';
    const original = await readFile(file, 'utf8');
    return transformBrand(original, file, 'apps/desktop') ?? original;
  };
  const history = await view('SpendingHistory');
  assert.equal(history.match(/<ScrollTable\b/g)?.length, 1);
  assert.match(history, /<DataCell label="Source">/);
  assert.match(history, /<Badge>\{row.source\}<\/Badge>/);
  const budget = (await view('X402Payments')).split(
    'export function X402History',
  )[0]!;
  assert.doesNotMatch(budget, /<ScrollTable|<X402History|Chat spending table/);
});

void test('Payments exposes the wallet directly and Activity lists usage without a payment ledger', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const view = async (name: string) => {
    const file = 'apps/desktop/src/ui/' + name + '.tsx';
    const source = await readFile(file, 'utf8');
    return transformBrand(source, file, 'apps/desktop') ?? source;
  };
  assert.match(
    await view('Payments'),
    /<PagePanel>\s*<TabBar[\s\S]*?<WalletOverview/,
  );
  assert.doesNotMatch(await view('Activity'), /<HistorySummary|<X402History/);
});

void test('usage periods filter requests before grouping and keep unknown tokens distinct from zero', async () => {
  const { usageReport, USAGE_PERIOD } =
    await import('../../lab/tools/desktop-preview/usage');
  const now = new Date(2026, 10, 18, 12).getTime();
  const chat = {
    id: 'a',
    title: 'First chat',
    source: 'Chat' as const,
    at: now,
    tokens: 12,
  };
  const api = { ...chat, id: 'b', source: 'API' as const, tokens: null };
  const events = [
    chat,
    api,
    { ...chat, at: new Date(2026, 10, 1).getTime(), tokens: 8 },
    { ...chat, at: new Date(2026, 6, 1).getTime(), tokens: 50 },
    { ...chat, at: new Date(2026, 5, 30).getTime(), tokens: 40 },
  ];
  const report = (period: (typeof USAGE_PERIOD)[keyof typeof USAGE_PERIOD]) =>
    usageReport(events, period, now);
  assert.deepEqual(report(USAGE_PERIOD.DAY).totals, {
    Chat: 1,
    API: 1,
    tokens: 12,
    measured: 1,
  });
  assert.equal(
    report(USAGE_PERIOD.MONTH).rows.find((row) => row.id === chat.id)?.count,
    2,
  );
  assert.equal(report(USAGE_PERIOD.HALF).totals.tokens, 70);
  assert.equal(report(USAGE_PERIOD.YEAR).totals.tokens, 110);
  assert.equal(
    usageReport([{ ...api, tokens: 0 }], USAGE_PERIOD.DAY, now).totals.measured,
    1,
  );
});

void test('usage cards compare the elapsed part of the previous calendar period', async () => {
  const { previousUsageTotals, usageChange, USAGE_PERIOD } =
    await import('../../lab/tools/desktop-preview/usage');
  const at = (month: number, day: number) =>
    new Date(2026, month - 1, day, 12).getTime();
  const events = [at(10, 1), at(10, 18), at(10, 19), at(11, 1)].map((time) => ({
    id: 'example',
    source: 'Chat' as const,
    title: 'Chat',
    at: time,
    tokens: 12,
  }));
  assert.equal(
    previousUsageTotals(events, USAGE_PERIOD.MONTH, at(11, 18))?.tokens,
    24,
  );
  assert.equal(previousUsageTotals(events, USAGE_PERIOD.ALL, at(11, 18)), null);
  assert.equal(usageChange(36, 24), 50);
  assert.equal(usageChange(50, 0), null);
});

void test('Activity and both payment methods render the shared metric cards', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  for (const name of ['ActivitySessions', 'Payments', 'PaypalSessionPanel']) {
    const file = 'apps/desktop/src/ui/' + name + '.tsx';
    const source = await readFile(file, 'utf8');
    const view = transformBrand(source, file, 'apps/desktop') ?? source;
    assert.match(view, /<StatGrid>/, name);
    assert.match(view, /<StatCard\b/, name);
  }
});

void test('Payments presents three spending metrics and shows the wallet address once', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const file = 'apps/desktop/src/ui/Payments.tsx';
  const view = transformBrand(
    await readFile(file, 'utf8'),
    file,
    'apps/desktop',
  );
  assert.ok(view);
  assert.doesNotMatch(view, /ui-wallet-overview|Wallet address · Solana/);
  assert.match(view, /<code title=\{address\}>/);
  assert.equal(view.match(/<StatCard\b/g)?.length, 3);
});

void test('metric changes distinguish unchanged readings from missing comparisons', async () => {
  const { usageChange } = await import('../../lab/tools/desktop-preview/usage');
  assert.equal(usageChange(0, 0), 0);
  assert.equal(usageChange(100, 100), 0);
  assert.equal(usageChange(0, 100), -100);
  assert.equal(usageChange(1, 0), null);
  assert.equal(usageChange(null, 100), null);
  assert.equal(usageChange(0, null), null);
});

void test('unobserved sources have neither a measured amount nor a measured change', async () => {
  const { measuredMetric } =
    await import('../../lab/tools/desktop-preview/usage');
  assert.deepEqual(measuredMetric(false, 0, 0), { value: null, change: null });
  assert.deepEqual(measuredMetric(true, 0, 0), { value: 0, change: 0 });
});

void test('wallet and PayPal actions belong to their payment method in the preview', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const render = async (name: string) => {
    const path = 'apps/desktop/src/ui/' + name + '.tsx';
    return (
      transformBrand(await readFile(path, 'utf8'), path, 'apps/desktop') ?? ''
    );
  };
  const payments = await render('Payments');
  assert.match(
    payments,
    /aria-label="Spending limit"[\s\S]*?onClick=\{onBudget\}/,
  );
  assert.match(payments, /label="Spending limit · USDC"/);
  assert.doesNotMatch(
    payments + (await render('X402Payments')),
    /account (budget|spending limit)/i,
  );
  assert.match(payments, /aria-label="PayPal"[\s\S]*?onClick=\{openPaypal\}/);
  assert.doesNotMatch(await render('SpendingHistory'), /action=\{actions\}/);
});

void test('Wallet details opts into the large preview dialog', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const path = 'apps/desktop/src/ui/Payments.tsx';
  const payments = transformBrand(
    await readFile(path, 'utf8'),
    path,
    'apps/desktop',
  );
  assert.match(payments ?? '', /<Modal title="Wallet details" size="lg"/);
});

void test('preview screens name the chain only when identifying the network at the faucet', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const directory = 'apps/desktop/src/ui';
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.tsx')) continue;
    const path = directory + '/' + file;
    const source = await readFile(path, 'utf8');
    const view = transformBrand(source, path, 'apps/desktop') ?? source;
    const faucetInstruction =
      'select USDC and Solana Devnet at the Circle faucet';
    if (file === 'BuyerFunding.tsx')
      assert.ok(view.includes(faucetInstruction));
    const labels =
      file === 'BuyerFunding.tsx' ? view.replace(faucetInstruction, '') : view;
    assert.equal(/(?<![@./])\bsolana\b(?![.:/])/i.test(labels), false, file);
  }
});

void test('preview omits the free-network composer caption and retains operational status copy', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const chat = await readFile(
    new URL('../../apps/desktop/src/ui/Chat.tsx', import.meta.url),
    'utf8',
  );
  const preview =
    transformBrand(chat, '/desktop/src/ui/Chat.tsx', '/desktop') ?? chat;
  assert.doesNotMatch(preview, /Free · Gyblos network/);
  for (const status of [
    'Generating…',
    'Authorize in Payments',
    "'x402'",
    'PayPal Sandbox',
    'Set up in Payments',
    'Esc to stop',
  ])
    assert.ok(preview.includes(status));
});

void test('preview payment, session and key lists use the same table component', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  for (const view of ['SpendingHistory', 'ActivitySessions', 'UsdcApiKeys']) {
    const file = 'apps/desktop/src/ui/' + view + '.tsx';
    const source = await readFile(file, 'utf8');
    const rendered = transformBrand(source, file, 'apps/desktop') ?? source;
    assert.ok(
      rendered.includes('<ScrollTable'),
      view + ' must use the shared table',
    );
    assert.doesNotMatch(rendered, /<(?:DataTable|table)\b/);
  }
});

void test('preview composer keeps the tools icon, opens its menus upward and seeds past chats', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const tools = 'apps/desktop/src/ui/ChatTools.tsx';
  const toolsSource = await readFile(tools, 'utf8');
  const toolsView =
    transformBrand(toolsSource, tools, 'apps/desktop') ?? toolsSource;
  assert.match(toolsView, /trigger=\{<Wrench\b/);
  const dropdown = 'apps/desktop/src/ui/Dropdown.tsx';
  const dropdownSource = await readFile(dropdown, 'utf8');
  const dropdownView =
    transformBrand(dropdownSource, dropdown, 'apps/desktop') ?? dropdownSource;
  assert.match(dropdownView, /anchor\.closest\('\.composer'\)/);
  const host = await readFile('lab/tools/desktop-preview/host.ts', 'utf8');
  assert.doesNotMatch(
    host,
    /setDraft\(title\)/,
    'sample sidebar chats must contain messages, not empty drafts',
  );
});

void test('preview menus that open upward stay glued to their trigger when their height changes', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const dropdown = 'apps/desktop/src/ui/Dropdown.tsx';
  const dropdownSource = await readFile(dropdown, 'utf8');
  const dropdownView =
    transformBrand(dropdownSource, dropdown, 'apps/desktop') ?? dropdownSource;
  assert.match(
    dropdownView,
    /menu\.style\.bottom = up \?/,
    'an upward menu is anchored by its bottom edge, not a top computed from a stale height',
  );
  const picker = await readFile(
    'lab/tools/desktop-preview/views/ModelDropdown.tsx.preview',
    'utf8',
  );
  assert.match(
    picker,
    /panel\.style\.bottom = /,
    'the seller panel follows the model menu bottom edge',
  );
});

void test('preview model picker keeps one selection signal, short seller rows and aligned columns', async () => {
  const picker = await readFile(
    'lab/tools/desktop-preview/views/ModelDropdown.tsx.preview',
    'utf8',
  );
  const css = await previewStyles();
  assert.doesNotMatch(
    picker,
    /' · Needs funds'|'Needs funds' : ''/,
    'the balance line and wallet icon say a model needs funds; rows do not repeat it',
  );
  assert.match(picker, /\\u2060…\\u2060/, 'a shortened seller id never wraps');
  assert.match(
    picker,
    /className="preview-offer-price"/,
    'the price sits in its own column',
  );
  assert.match(
    picker,
    /'Same seller as '/,
    'strategies that pick the same seller say so',
  );
  assert.match(
    picker,
    /preview-caret-slot/,
    'single-seller rows keep the caret column',
  );
  assert.doesNotMatch(
    css,
    /\.preview-model-menu \.dropdown-row\[data-active\] \{\n {2}background: var\(--soft\)/,
    'the open model row is not tinted with the accent',
  );
  assert.match(
    css,
    /\.dropdown-row\[data-strategy\] \{\n {2}align-items: center;/,
  );
  assert.match(
    css,
    /\.preview-seller-flyout\)\s+\.dropdown-footer \{\n {2}margin-top: auto;/,
  );
  assert.match(
    css,
    /--preview-name-type: 'Instrument Sans'/,
    'model names do not mix in mono digits',
  );
});

void test('preview Connections leads with a tool grid and an inline setup guide', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const keys = await readFile(
    'lab/tools/desktop-preview/views/UsdcApiKeys.tsx.preview',
    'utf8',
  );
  assert.match(keys, /className="preview-tool-grid"/);
  assert.match(keys, /aria-pressed=\{/, 'tool cards are toggle buttons');
  assert.match(keys, /'Configured'/, 'each tool shows its setup state');
  assert.match(keys, /className="preview-tool-guide"/);
  assert.doesNotMatch(
    keys,
    /view === 'choose'|view === 'guide'/,
    'tool setup no longer hides inside a modal',
  );
  assert.match(
    keys,
    /useEffect\(\(\) => setKeyCopied\(false\), \[guideKey\?\.id, tool\]\)/,
    'the copy step is redone after picking another key or tool',
  );
  const chat = 'apps/desktop/src/ui/Chat.tsx';
  const source = await readFile(chat, 'utf8');
  const rendered = transformBrand(source, chat, 'apps/desktop') ?? source;
  assert.ok(
    rendered.includes('<PreviewConnectEntry'),
    'the empty chat offers to connect a dev tool',
  );
});

void test('preview chat answers show a skeleton while the reply is pending', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const file = 'apps/desktop/src/ui/ChatAnswer.tsx';
  const source = await readFile(file, 'utf8');
  const rendered = transformBrand(source, file, 'apps/desktop') ?? source;
  assert.ok(rendered.includes('className="preview-answer-skeleton"'));
  const css = await previewStyles();
  assert.match(css, /\.preview-answer-skeleton/);
  assert.match(
    css,
    /prefers-reduced-motion: reduce\)\s*\{[^}]*preview-answer-skeleton/,
    'the shimmer stops for reduced motion',
  );
});

void test('Compare sellers opens the detail of that model', async () => {
  const picker = await readFile(
    'lab/tools/desktop-preview/views/ModelDropdown.tsx.preview',
    'utf8',
  );
  const row = await readFile(
    'lab/tools/desktop-preview/views/ModelRow.tsx.preview',
    'utf8',
  );
  assert.doesNotMatch(picker, /sellers in Models/);
  assert.doesNotMatch(
    picker + row,
    /previewOpenModel/,
    'the catalog rows are other models; matching them by name opened the wrong detail',
  );
  assert.match(picker, /setCompare\(active\)/);
  assert.match(
    picker,
    /<Modal\s+title=\{compare\}\s+size="lg"[\s\S]*compareOffers\.map/,
    'the dialog lists the sellers of the exact model being compared',
  );
});

void test('Payments history tables become cards in narrow layouts', async () => {
  const css = await previewStyles();
  assert.match(
    css,
    /@container \(max-width: 620px\)\s*\{[^@]*\.ui-table-region \.ui-data-table tbody tr \{\s*display: grid;/,
  );
});
