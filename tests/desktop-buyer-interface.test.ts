// Guards the buyer's no-accordion interaction rule without launching payment services.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const buyerScreens = [
  'apps/desktop/src/desktop-app.tsx',
  'apps/desktop/src/ui/PaypalSessionPanel.tsx',
  'apps/desktop/src/ui/PaypalAgentConnection.tsx',
  'apps/desktop/src/ui/PaypalAgentSetup.tsx',
  'apps/desktop/src/ui/Connections.tsx',
  'apps/desktop/src/ui/Chat.tsx',
  'apps/desktop/src/ui/ChatPaymentSelector.tsx',
  'apps/desktop/src/ui/SpendingHistory.tsx',
];

void test('buyer screens keep content visible without accordions', async () => {
  for (const screen of buyerScreens) {
    const source = await readFile(screen, 'utf8');
    assert.doesNotMatch(source, /<details\b|<summary\b/, screen);
    if (screen.endsWith('/Connections.tsx') || screen.endsWith('/Chat.tsx')) {
      assert.doesNotMatch(
        source,
        /aria-expanded|MOTION_VARIANT\.EXPAND/,
        screen,
      );
    }
  }
});

void test('session explanations do not substitute current defaults for restored terms', async () => {
  for (const screen of [
    'apps/desktop/src/ui/Chat.tsx',
    'apps/desktop/src/ui/PaypalSessionPanel.tsx',
    'apps/desktop/src/ui/PaypalAgentConnection.tsx',
  ]) {
    const source = await readFile(screen, 'utf8');
    assert.equal(source.includes('PAYPAL_SANDBOX.'), false, screen);
  }
});

void test('shared exclusive selection uses native radio controls', async () => {
  const source = await readFile('apps/desktop/src/ui/UI.tsx', 'utf8');
  const start = source.indexOf('export function ChoiceCard');
  const end = source.indexOf('export function MenuItem', start);
  const choice = source.slice(start, end);
  assert.match(choice, /type="radio"/);
  assert.doesNotMatch(choice, /aria-pressed/);
});

void test('preview web services never claim to be connected', async () => {
  const source = await readFile('apps/desktop/src/ui/ChatTools.tsx', 'utf8');
  assert.doesNotMatch(source, /'Connected'|'Connect and enable'/);
  assert.match(source, /Coming soon/);
  assert.match(source, /preview/i);
});

void test('the model picker alone shows the approved chat selector caret', async () => {
  const picker = await readFile(
    'apps/desktop/src/ui/ModelDropdown.tsx',
    'utf8',
  );
  assert.match(
    picker,
    /<CaretDown\s+size=\{12\}\s+weight="bold"\s+className="preview-trigger-caret"/,
  );
  for (const screen of [
    'apps/desktop/src/ui/ChatTools.tsx',
    'apps/desktop/src/ui/ChatPaymentSelector.tsx',
  ]) {
    const source = await readFile(screen, 'utf8');
    assert.doesNotMatch(source, /CaretDown/, screen);
  }
});

void test('the agents screen cannot create a PayPal connection while USDC is selected', async () => {
  const source = await readFile('apps/desktop/src/desktop-app.tsx', 'utf8');
  assert.match(
    source,
    /<PaypalAgentConnection\s+onlyConnected=\{paymentMethod !== PAYMENT_METHOD\.PAYPAL\}/,
  );
  assert.match(source, /onPayments=\{reviewPaypalPayments\}/);
});

void test('every searchable desktop menu shows an empty state when nothing matches', async () => {
  const directory = 'apps/desktop/src/ui';
  const menus = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.tsx')) continue;
    const source = await readFile(`${directory}/${file}`, 'utf8');
    const searchable = source.match(/searchLabel=/g)?.length ?? 0;
    if (!searchable) continue;
    menus.push(file);
    const emptyStates =
      source.match(/className="dropdown-note" role="status"/g)?.length ?? 0;
    assert.ok(emptyStates >= searchable, file);
  }
  assert.ok(menus.includes('Management.tsx'));
});

void test('desktop detail and confirmation dialogs use the approved widths', async () => {
  const ui = 'apps/desktop/src/ui/';
  const settings = await readFile(ui + 'Settings.tsx', 'utf8');
  assert.match(settings, /title="About Gyblos"\s+size="sm"/);
  assert.match(settings, /title="Design system"\s+size="lg"/);
  assert.match(
    await readFile(ui + 'Payments.tsx', 'utf8'),
    /title="Wallet details"\s+size="lg"/,
  );
  assert.match(
    await readFile(ui + 'UsdcApiKeyDetails.tsx', 'utf8'),
    /title="Revoke API key\?"\s+size="sm"/,
  );
});

void test('network search shows results only for a submitted model ID', async () => {
  const source = await readFile(
    'apps/desktop/src/ui/NetworkCatalog.tsx',
    'utf8',
  );
  assert.match(
    source,
    /snapshot\.query && query\.trim\(\) === snapshot\.query && !expanded/,
  );
});

void test('the native Limits view fits the approved narrow window and identifies the limit-used card', async () => {
  const desktop = await readFile('apps/desktop/src/constants.ts', 'utf8');
  const minimum = /MIN_WIDTH:\s*(\d+)/.exec(desktop);
  assert.ok(minimum && Number(minimum[1]) <= 596);
  const limits = await readFile(
    'apps/desktop/src/ui/SpendingLimits.tsx',
    'utf8',
  );
  assert.match(
    limits,
    /aria-label="Limit used">\s*<h3>Spending limit used<\/h3>/,
  );
});

void test('composer balance uses a live inline spinner only while the payer balance is read', async () => {
  const chat = await readFile('apps/desktop/src/ui/Chat.tsx', 'utf8');
  assert.match(
    chat,
    /checking=\{active && usingX402 && !!payer && loading\}/,
  );
  const composer = await readFile(
    'apps/desktop/src/ui/ComposerFunding.tsx',
    'utf8',
  );
  assert.match(composer, /checking: boolean;/);
  assert.match(composer, /aria-live="polite"/);
  assert.match(composer, /aria-busy=\{checking\}/);
  assert.match(composer, /<InlineSpinner \/>/);
  assert.match(composer, /Checking balance…/);
  assert.match(composer, /fundingAmount\(funding\.balanceAtomic\)/);
  assert.doesNotMatch(composer, /Last checked ·/);
  const ui = await readFile('apps/desktop/src/ui/UI.tsx', 'utf8');
  assert.match(ui, /export function InlineSpinner\(/);
  const css = await readFile('apps/desktop/src/ui/ui.css', 'utf8');
  assert.match(
    css,
    /\.ui-inline-spinner\s*\{[^}]*animation: pk-spin 800ms linear infinite;/,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.desktop-frame \.ui-inline-spinner\s*\{\s*animation: none;/,
  );
});

void test('chat model picker keeps funds actions compact and leaves balance in the composer tab', async () => {
  const picker = await readFile(
    'apps/desktop/src/ui/ModelDropdown.tsx',
    'utf8',
  );
  assert.doesNotMatch(picker, /ModelMenuBalance/);
  assert.doesNotMatch(picker, /balanceStatus/);
  assert.match(picker, /className="preview-menu-actions"/);
  assert.match(picker, /label="Add funds"/);
  assert.match(picker, /label="View all models"/);
  assert.ok(
    picker.indexOf('label="Add funds"') <
      picker.indexOf('label="View all models"'),
  );
  assert.match(picker, /setAddingFunds\(true\)/);
  const files = await readdir('apps/desktop/src/ui');
  assert.equal(files.includes('ModelMenuBalance.tsx'), false);
  const css = await readFile(
    'apps/desktop/src/ui/buyer-controls.css',
    'utf8',
  );
  assert.match(css, /\.preview-menu-actions\s*\{[^}]*display: flex/);
  assert.match(css, /\.preview-menu-actions \.dropdown-footer\s*\{/);
  assert.doesNotMatch(css, /\.pk-balance-line/);
});

void test('the chat picker refreshes its balance on open and distinguishes a missing payer from a pending read', async () => {
  const { buyerBalanceStatus, emptyX402 } =
    await import('@gyblos/desktop/x402-model');
  const summary = emptyX402();
  assert.equal(buyerBalanceStatus(true, undefined, false), 'Checking…');
  assert.equal(buyerBalanceStatus(false, undefined, false), 'No status');
  assert.equal(
    buyerBalanceStatus(false, { summary, error: 'failed' }, false),
    'No status',
  );
  assert.equal(
    buyerBalanceStatus(
      false,
      { summary: { ...summary, available: false } },
      false,
    ),
    'No status',
  );
  assert.equal(buyerBalanceStatus(false, { summary }, false), 'No payer');
  assert.equal(buyerBalanceStatus(false, { summary }, true), 'No reading');
  const picker = await readFile(
    'apps/desktop/src/ui/ModelDropdown.tsx',
    'utf8',
  );
  assert.match(picker, /onOpen=\{props.refreshFunding\}/);
});

void test('history search consumes Escape before the window stop shortcut', async () => {
  const history = await readFile(
    'apps/desktop/src/ui/ConversationHistory.tsx',
    'utf8',
  );
  assert.match(history, /event\.stopPropagation\(\);\s*closeSearch\(\)/);
});

void test('key setup uses the selected key and explains the Codex and shell targets', async () => {
  const keys = await readFile('apps/desktop/src/ui/UsdcApiKeys.tsx', 'utf8');
  assert.match(keys, /action: USDC_API_ACTION.COPY_URL,\s*id: guideKey.id/);
  assert.match(keys, /profile file/);
  assert.match(keys, /shell that starts Claude Code/);
});

void test('usage remains accessible after a send error and payment links select the usage tab', async () => {
  const ui = 'apps/desktop/src/ui/';
  const sessions = await readFile(ui + 'ActivitySessions.tsx', 'utf8');
  assert.doesNotMatch(sessions, /!x402.state.error/);
  assert.match(sessions, /X402_ACTION.STATUS/);
  const payments = await readFile(ui + 'Payments.tsx', 'utf8');
  assert.match(payments, /setTab\('activity'\);\s*props.onActivity/);
  assert.match(payments, /manage=\{\(\) => openUsdc\(props.onConnections\)\}/);
});

void test('both payment wallet views use the same payer-scoped observation', async () => {
  const methods = await readFile(
    'apps/desktop/src/ui/PaymentMethods.tsx',
    'utf8',
  );
  assert.match(methods, /observation.refresh\(\);\s*onDetails\(\)/);
  for (const name of ['WalletDetails', 'PaymentMethods']) {
    const source = await readFile(
      'apps/desktop/src/ui/' + name + '.tsx',
      'utf8',
    );
    assert.doesNotMatch(source, /= useBuyerFunding\(/);
  }
});

void test('chat budget management and actual spending sources remain independent of form input', async () => {
  const limits = await readFile(
    'apps/desktop/src/ui/SpendingLimits.tsx',
    'utf8',
  );
  assert.doesNotMatch(
    limits,
    /!available && \(\s*<Button|!keys \|\| !keys.keys.length/,
  );
});

void test('Markdown export keeps a leading code fence on its own line', async () => {
  const { conversationMarkdown } = await import('@gyblos/desktop/chat-history');
  const fence = ['```ts', 'const value = 1;', '```'].join('\n');
  assert.equal(
    conversationMarkdown('Example', [{ role: 'assistant', text: fence }]),
    '# Example\n\n**Gyblos:**\n\n' + fence,
  );
  for (const opener of ['```ts', '~~~~js', '````']) {
    const stopped = opener + '\ncode';
    const closing = opener.replace(/[a-z]+$/, '');
    assert.equal(
      conversationMarkdown('Example', [
        { role: 'assistant', text: stopped },
        { role: 'user', text: 'Next?' },
      ]),
      '# Example\n\n**Gyblos:**\n\n' +
        stopped +
        '\n' +
        closing +
        '\n\n**You:**\n\nNext?',
    );
  }
});

void test('paid seller maximum names its currency and pending activity shows the Gyblos mark', async () => {
  const seller = await readFile(
    'apps/desktop/src/ui/PaidSellerDialog.tsx',
    'utf8',
  );
  assert.match(
    seller,
    /htmlFor="paid-response-maximum">\s*Maximum per response<span className="sr-only"> \(USDC\)<\/span>/,
  );
  const turn = await readFile('apps/desktop/src/ui/TurnActivity.tsx', 'utf8');
  assert.match(turn, /state === MESSAGE_STATE.PENDING && <SignalMark/);
});

void test('model catalog rows name one model and show a mode only for the model in use', async () => {
  const source = await readFile(
    'apps/desktop/src/ui/CatalogOffers.tsx',
    'utf8',
  );
  assert.doesNotMatch(source, /\{groups\.size\} models/);
  assert.doesNotMatch(source, /: '—'/);
  const css = (
    await readFile('apps/desktop/src/ui/desktop-design.css', 'utf8')
  ).replace(/\s+/g, ' ');
  assert.match(
    css,
    /\.desktop-frame \.preview-model-mode:not\(:empty\) \{[^}]*border-radius: 999px/,
  );
});

void test('spending limit actions share the compact action button', async () => {
  const source = await readFile(
    'apps/desktop/src/ui/SpendingLimits.tsx',
    'utf8',
  );
  assert.match(
    source,
    /<ActionButton\s+icon=\{<\w+ size=\{16\} \/>\}\s+label="Manage chat budget"/,
  );
});
