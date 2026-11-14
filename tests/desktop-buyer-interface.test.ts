// Guards the buyer's no-accordion interaction rule without launching payment services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const buyerScreens = [
  'apps/desktop/src/desktop-app.tsx',
  'apps/desktop/src/ui/PaypalSessionPanel.tsx',
  'apps/desktop/src/ui/PaypalAgentConnection.tsx',
  'apps/desktop/src/ui/PaypalAgentSetup.tsx',
  'apps/desktop/src/ui/Connections.tsx',
  'apps/desktop/src/ui/Chat.tsx',
  'apps/desktop/src/ui/ChatPaymentSelector.tsx',
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

void test('chat selectors do not show downward chevrons', async () => {
  for (const screen of [
    'apps/desktop/src/ui/ChatTools.tsx',
    'apps/desktop/src/ui/ModelDropdown.tsx',
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
