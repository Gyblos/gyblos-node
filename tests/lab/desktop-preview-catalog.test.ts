import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { previewStyles } from '../support/desktop-preview-styles';

const preview = new URL('../../lab/tools/desktop-preview/', import.meta.url);
const views = new URL('views/', preview);
const view = (name: string) => readFile(new URL(name, views), 'utf8');

void test('Add funds offers the faucet on Testnet only, from chat and Usage & payments', async () => {
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /export function PreviewFundsDialog\(/);
  assert.doesNotMatch(kit, /onClick=\{openPreviewFunds\}/);
  assert.match(
    kit,
    /network === 'Testnet' \? <AddBuyerFunds \/> : <PreviewMainnetFunds \/>/,
  );
  const payments = await view('Payments.tsx.preview');
  assert.match(payments, /<PreviewFundsDialog host=\{FUNDS_HOST\.PAYMENTS\}/);
  assert.match(payments, /openPreviewFunds\(FUNDS_HOST\.PAYMENTS\)/);
  const funding = await readFile(new URL('funding.ts', preview), 'utf8');
  assert.match(funding, /new URLSearchParams\(location\.search\)/);
});

void test('the seller table uses the shared pagination and a pinned-seller summary', async () => {
  const row = await view('ModelRow.tsx.preview');
  const kit = await view('PreviewKit.tsx.preview');
  const css = await previewStyles();
  const design = await readFile(new URL('DESIGN.md', preview), 'utf8');
  assert.match(row, /<Pagination\b/);
  assert.doesNotMatch(row, /preview-pager/);
  assert.match(row, /className="preview-route" data-tone=/);
  assert.match(row, /className="ui-icon-tile"/);
  assert.doesNotMatch(
    css,
    /\.preview-route-icon|\.preview-fund-options|--accent\) \d+%, var\(--panel/,
  );
  assert.match(kit, /className="preview-method-list"/);
  assert.match(design, /PreviewFundsDialog/);
  assert.match(row, /aria-pressed=\{pinned === s\.id\}/);
});

void test('the Models catalog scales with lab, family and sort filters and pagination', async () => {
  const row = await view('ModelRow.tsx.preview');
  assert.match(row, /function PreviewCatalog\(/);
  for (const label of ['Model lab', 'Model family', 'Sort models'])
    assert.match(row, new RegExp(`label="${label}"`));
  assert.match(row, /label="Model catalog pagination"/);
  const build = await readFile(new URL('models-build.ts', preview), 'utf8');
  assert.match(build, /<PreviewCatalog /);
});
