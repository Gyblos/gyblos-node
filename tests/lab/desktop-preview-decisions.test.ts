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

void test('preview API key details offer an optional fallback model', async () => {
  const details = await view('UsdcApiKeyDetails.tsx.preview');
  assert.match(details, /Fallback model/);
  assert.match(details, /<Dropdown/);
  assert.match(
    await view('UsdcApiKeys.tsx.preview'),
    /<FallbackModel id=\{id\} \/>/,
  );
  const kit = await view('PreviewKit.tsx.preview');
  assert.match(kit, /similarFreeModel\(/);
});

void test('preview paid-model confirmation formats the same listed prices as the picker', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const file = 'apps/desktop/src/desktop-app.tsx';
  const app =
    transformBrand(await readFile(file, 'utf8'), file, 'apps/desktop') ?? '';
  assert.match(app, /import \{ usdPerMtok \} from '\.\/ui\/model-price';/);
});
