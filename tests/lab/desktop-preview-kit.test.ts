import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const views = new URL(
  '../../lab/tools/desktop-preview/views/',
  import.meta.url,
);

void test('preview views take colors from theme variables and kit tones, not literals', async () => {
  for (const file of await readdir(views)) {
    if (!file.endsWith('.tsx.preview')) continue;
    const source = await readFile(new URL(file, views), 'utf8');
    assert.doesNotMatch(
      source,
      /['"`]#[0-9a-f]{3,8}['"`]|rgba?\(|hsla?\(|oklch\(/i,
      file,
    );
  }
});

void test('preview kit status tones follow the mockup design rules', async () => {
  const kit = await readFile(new URL('PreviewKit.tsx.preview', views), 'utf8');
  for (const name of [
    'Tag',
    'Switch',
    'Delta',
    'Savings',
    'SegmentedBar',
    'FilterChips',
    'Panel',
    'PreviewKitShowcase',
  ])
    assert.match(kit, new RegExp('export function ' + name + '\\b'), name);
  assert.match(kit, /import \{ Notice \} from '\.\/Notice';/);
  assert.match(kit, /export \{ Notice \};/);
  const notice = await readFile(
    new URL('../../apps/desktop/src/ui/Notice.tsx', import.meta.url),
    'utf8',
  );
  assert.match(notice, /export function Notice\(/);
  assert.match(notice, /tone = TONE\.WARNING/);
  assert.match(notice, /data-tone=\{tone\} role="status"/);
  const design = await readFile(new URL('../DESIGN.md', views), 'utf8');
  for (const tone of ['success', 'warning', 'danger', 'info', 'neutral'])
    assert.match(design, new RegExp('`' + tone + '`'));
});

void test('the preview spending limit editor never finishes the payment session', async () => {
  const payments = await readFile(
    new URL('Payments.tsx.preview', views),
    'utf8',
  );
  assert.doesNotMatch(payments, /X402_ACTION\.FINISH/);
  assert.doesNotMatch(payments, /Leave empty for no limit/);
  assert.match(
    payments,
    /!text\s*\?\s*dirty\s*\?\s*'Enter a spending limit\.'\s*:\s*''/,
  );
});

void test('preview status tones map desktop payment statuses as DESIGN.md documents', async () => {
  const { statusTone } =
    await import('../../lab/tools/desktop-preview/status-tone');
  const expected = {
    'Payment captured': 'success',
    Confirmed: 'success',
    Active: 'success',
    'Session open': 'info',
    'Awaiting approval': 'info',
    'Capture unconfirmed': 'warning',
    'Response unconfirmed': 'warning',
    'Needs review': 'warning',
    'Paid limit reached': 'warning',
    Failed: 'danger',
    'Authorization voided': 'neutral',
    'Checkout cancelled': 'neutral',
    Revoked: 'neutral',
    Free: 'neutral',
  };
  for (const [status, tone] of Object.entries(expected))
    assert.equal(statusTone(status), tone, status);
});
