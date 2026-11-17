// Validates synthetic browser fixtures against the unchanged desktop's public parsers; no network or keys.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { before, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { parseActivityResult } from '@gyblos/desktop/activity-model';
import { parseChatArchiveLoad } from '@gyblos/desktop/chat-archive-model';
import { parsePaymentReferences } from '@gyblos/desktop/payment-reference-model';
import { parsePaypalAgentResult } from '@gyblos/desktop/paypal-agent-model';
import { parsePaypalResult } from '@gyblos/desktop/paypal-model';
import {
  parseUsdcApiState,
  USDC_API_ACTION,
} from '@gyblos/desktop/usdc-api-model';
import { parseWalletCollection } from '@gyblos/desktop/wallet-settings-model';
import { parseX402Result } from '@gyblos/desktop/x402-model';

import { buildPreview } from '../../lab/tools/desktop-preview/build';
import { assertImportsInert } from '../support/inertness';

let output = '';
let bridge = '';
before(async () => {
  output = await buildPreview();
  bridge = resolve(output, 'preview.js');
});
function object(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object');
  return Object.fromEntries(Object.entries(input));
}
async function fixture() {
  const window: Record<string, unknown> = { setTimeout, clearTimeout };
  runInNewContext(await readFile(bridge, 'utf8'), {
    window,
    document: { title: '', documentElement: {}, querySelectorAll: () => [] },
    MutationObserver: class {
      observe() {}
    },
    location: { search: '?state=ready&connection-state=ready' },
    crypto: webcrypto,
    navigator: { clipboard: { writeText: async () => {} } },
    structuredClone,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    console,
  });
  return async (
    name: string,
    method: string,
    input?: unknown,
  ): Promise<unknown> => {
    const target = object(window[name]);
    const action = target[method];
    assert.equal(typeof action, 'function');
    if (typeof action !== 'function') throw new Error('Missing preview bridge');
    const value: unknown = await action(input);
    return value;
  };
}
void test('preview restores example conversation history with a completed response', async () => {
  const call = await fixture();
  const result = parseChatArchiveLoad(
    await call('desktopConversations', 'load'),
  );
  assert.equal(result.available, true);
  assert.equal(result.archive?.sessions.length, 4);
  assert.equal(result.archive?.sessions.at(-1)?.messages.length, 2);
  assert.equal(
    result.archive?.sessions.at(-1)?.messages.at(-1)?.model.name,
    'qwen3-0.6b',
  );
});
void test('preview exposes bounded synthetic API key metadata without a credential', async () => {
  const call = await fixture();
  const result = parseUsdcApiState(
    await call('desktopUsdcApiKeys', 'run', { action: 'status' }),
  );
  assert.equal(result.snapshot?.keys[0]?.limitAtomic, '10000');
  assert.equal(result.snapshot?.keys[0]?.spentAtomic, '2000');
  assert.doesNotMatch(
    JSON.stringify(result),
    /PREVIEW_ONLY_NOT_A_VALID_API_KEY/,
  );
});
void test('preview buyer status is runtime-loadable and keeps free replies transaction-free', async () => {
  const call = await fixture();
  const result = parseX402Result(
    await call('desktopX402', 'run', { action: 'status' }),
  );
  assert.equal(result.summary.active, true);
  assert.equal(result.summary.records[0]?.transaction, null);
  assert.equal(result.summary.records[0]?.chargeAtomic, '0');
});
void test('preview wallet collection contains public example metadata only', async () => {
  const call = await fixture();
  const result = parseWalletCollection(
    await call('desktopWallet', 'collection'),
  );
  assert.equal(result.wallet.status, 'ready');
  assert.equal(result.wallet.fundingEnabled, false);
});
void test('preview PayPal status follows the current public contract', async () => {
  const call = await fixture();
  const result = parsePaypalResult(
    await call('desktopPaypal', 'run', { action: 'status' }),
  );
  assert.equal(result.error, null);
  assert.equal(result.status?.spentCents, 20);
});
void test('preview PayPal agent has independent key and session limits', async () => {
  const call = await fixture();
  const result = parsePaypalAgentResult(
    await call('desktopPaypalAgent', 'run', { action: 'status' }),
  );
  assert.equal(result.error, null);
  assert.equal(result.connection?.keyLimitCents, 100);
  assert.equal(result.connection?.limitCents, 500);
});
void test('preview activity separates chat and agent usage with consistent totals', async () => {
  const call = await fixture();
  const result = parseActivityResult(await call('desktopActivity', 'summary'));
  assert.equal(result.available, true);
  assert.equal(result.sessions.length, 25);
  assert.equal(result.sessions[0]?.chatCents, 10);
  assert.equal(result.sessions[0]?.agentCents, 10);
});
void test('preview payment reference samples satisfy the desktop contract', async () => {
  const call = await fixture();
  const result = parsePaymentReferences(
    await call('desktopActivity', 'references'),
  );
  assert.equal(result.available, true);
  assert.ok(result.references.length > 0);
});
void test('preview PayPal chat and agents share one model', async () => {
  const call = await fixture();
  const chat = parsePaypalResult(
    await call('desktopPaypal', 'run', { action: 'status' }),
  );
  const agent = parsePaypalAgentResult(
    await call('desktopPaypalAgent', 'run', { action: 'status' }),
  );
  assert.equal(agent.connection?.model, chat.model);
});
void test('preview generates each agent configuration with its own format', async () => {
  const call = await fixture();
  const codex = parseUsdcApiState(
    await call('desktopUsdcApiKeys', 'run', {
      action: USDC_API_ACTION.PREVIEW_AGENT,
      tool: 'codex',
      id: '00000000-0000-4000-8000-000000000002',
    }),
  );
  const claude = parseUsdcApiState(
    await call('desktopUsdcApiKeys', 'run', {
      action: USDC_API_ACTION.PREVIEW_AGENT,
      tool: 'claude',
      id: '00000000-0000-4000-8000-000000000002',
    }),
  );
  assert.match(codex.setup?.text ?? '', /\[model_providers\.gyblos\]/);
  assert.match(claude.setup?.text ?? '', /export ANTHROPIC_BASE_URL=/);
});
void test('preview build retains a desktop baseline and declares its brand proposal', async () => {
  const text = await readFile(resolve(output, 'source-manifest.json'), 'utf8');
  const data: unknown = JSON.parse(text);
  const manifest = object(data);
  assert.equal(manifest.nativeServices, false);
  assert.equal(manifest.syntheticData, true);
  const brand = object(manifest.brand);
  const tokens = object(brand.themeTokens);
  assert.equal(tokens.blue, '#0a28f0');
  assert.equal(tokens.charcoal, '#090909');
  assert.equal(brand.kitVersion, '3.0.0');
  const baseline = object(manifest.baselineAssets);
  const preview = object(manifest.previewAssets);
  assert.equal(Object.keys(baseline).length, 2);
  assert.equal(Object.keys(preview).length, 2);
  assert.notDeepEqual(baseline, preview);
});
void test('preview blocks network access and uses only its synthetic bridge', async () => {
  const html = await readFile(resolve(output, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /src="\.\/preview.js"/);
  assert.doesNotMatch(html, /review-flow|preview-bridge|preload|worker/);
});
void test('preview modules are inert until explicitly started', async () => {
  await assertImportsInert(async () => {
    await import('../../lab/tools/desktop-preview/host');
    await import('../../lab/tools/desktop-preview/browser');
    await import('../../lab/tools/desktop-preview/build');
  });
});
