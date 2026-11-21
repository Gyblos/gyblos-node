// Validates synthetic browser fixtures against the unchanged desktop's public parsers; no network or keys.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { parseActivityResult } from '@gyblos/desktop/activity-model';
import { parseChatArchiveLoad } from '@gyblos/desktop/chat-archive-model';
import {
  CATALOG_STATE,
  parseNetworkCatalog,
} from '@gyblos/desktop/network-catalog';
import { parsePaymentReferences } from '@gyblos/desktop/payment-reference-model';
import {
  parsePaypalAgentResult,
  PAYPAL_AGENT_COPY,
} from '@gyblos/desktop/paypal-agent-model';
import { parsePaypalResult } from '@gyblos/desktop/paypal-model';
import {
  parseUsdcApiState,
  USDC_API_ACTION,
} from '@gyblos/desktop/usdc-api-model';
import { parseWalletCollection } from '@gyblos/desktop/wallet-settings-model';
import { parseX402Result, X402_ACTION } from '@gyblos/desktop/x402-model';

import { assertImportsInert } from '../support/inertness';

let output = '';
let bridge = '';
let temporary = '';
before(async () => {
  let build: typeof import('../../lab/tools/desktop-preview/build') | undefined;
  await assertImportsInert(async () => {
    build = await import('../../lab/tools/desktop-preview/build');
    await import('../../lab/tools/desktop-preview/browser');
  });
  assert.ok(build);
  temporary = await mkdtemp(resolve(tmpdir(), 'gyblos-web-preview-test-'));
  output = await build.buildPreview(resolve(temporary, 'output'));
  bridge = resolve(output, 'preview.js');
});
after(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
function object(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object');
  return Object.fromEntries(Object.entries(input));
}
async function fixture(search = '?state=ready&connection-state=ready') {
  const clipboardWrites: string[] = [];
  const observations: boolean[] = [];
  const window: Record<string, unknown> = { setTimeout, clearTimeout };
  runInNewContext(await readFile(bridge, 'utf8'), {
    window,
    document: { title: '', documentElement: {}, querySelectorAll: () => [] },
    MutationObserver: class {
      observe() {
        observations.push(true);
      }
    },
    location: { search },
    crypto: webcrypto,
    navigator: {
      clipboard: {
        writeText: async (text: string) => {
          clipboardWrites.push(text);
        },
      },
    },
    structuredClone,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    console,
  });
  const call = async (
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
  return Object.assign(call, { clipboardWrites, observations });
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
void test('the optional chat budget excludes API keys and preserves individual limits', async () => {
  const call = await fixture('?screen=payments&review=ten-chats');
  const readAccount = async () =>
    object(await call('previewAccountBudget', 'current'));
  const original = await readAccount();
  assert.equal(original.limitAtomic, '1000000');
  assert.equal(original.spentAtomic, '0');
  const setLimit = async (limitAtomic: string) =>
    parseX402Result(
      await call('desktopX402', 'run', {
        action: X402_ACTION.AUTHORIZE,
        limitAtomic,
      }),
    );
  assert.ok((await setLimit('-1')).error);
  assert.deepEqual(await readAccount(), original);
  assert.equal((await setLimit('6000')).error, undefined);
  assert.equal((await readAccount()).limitAtomic, '6000');
  const keys = parseUsdcApiState(
    await call('desktopUsdcApiKeys', 'run', { action: 'status' }),
  );
  assert.equal(keys.snapshot?.keys[0]?.limitAtomic, '10000');
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
void test('preview network catalog passes the desktop contract with models offered by several sellers', async () => {
  const call = await fixture();
  const catalog = parseNetworkCatalog(await call('desktopCatalog', 'summary'));
  assert.equal(catalog.state, CATALOG_STATE.READY);
  const prices = (models: typeof catalog.models) =>
    models.map((model) => model.modelId + ' ' + model.inputAtomicPerMtok);
  assert.deepEqual(prices(catalog.models), [
    'qwen3-0.6b 0',
    'qwen3-0.6b 52000',
    'qwen3-0.6b 80000',
    'llama-3.2-3b 60000',
    'llama-3.2-3b 90000',
    'gemma-3-4b 70000',
  ]);
  const lookup = async (query: string) =>
    parseNetworkCatalog(await call('desktopCatalog', 'lookup', query)).models;
  assert.deepEqual(prices(await lookup('llama-3.2-3b')), [
    'llama-3.2-3b 60000',
    'llama-3.2-3b 90000',
  ]);
});

void test('preview wallet collection contains public example metadata only', async () => {
  const call = await fixture();
  const result = parseWalletCollection(
    await call('desktopWallet', 'collection'),
  );
  assert.equal(result.wallet.status, 'ready');
  assert.equal(result.wallet.fundingEnabled, false);
});
void test('wallet backup review reflects verified and needed states in the collection', async () => {
  for (const [state, verified] of [
    ['verified', true],
    ['needed', false],
  ] as const) {
    const call = await fixture(
      '?screen=payments&review=wallet-backup&backup=' + state,
    );
    const { wallet, wallets } = parseWalletCollection(
      await call('desktopWallet', 'collection'),
    );
    assert.equal(wallet.backupVerified, verified);
    assert.equal(wallets[0]?.backupVerified, verified);
  }
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
  assert.equal(tokens.charcoal, '#141414');
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

void test('preview Settings URL selects the documented initial route', async () => {
  const call = await fixture('?screen=settings');
  assert.equal(call.observations.length, 1);
});
void test('preview closing Chat spending permission retains the observed payment history', async () => {
  const call = await fixture();
  const before = parseX402Result(
    await call('desktopX402', 'run', { action: X402_ACTION.STATUS }),
  );
  const after = parseX402Result(
    await call('desktopX402', 'run', { action: X402_ACTION.FINISH }),
  );
  assert.equal(after.summary.active, false);
  assert.deepEqual(after.summary.records, before.summary.records);
  assert.equal(after.summary.sessionId, before.summary.sessionId);
  assert.equal(after.summary.limitAtomic, before.summary.limitAtomic);
});
void test('preview copies the requested PayPal URL instead of its sample key', async () => {
  const call = await fixture();
  assert.equal(
    await call('desktopPaypalAgent', 'copy', { target: PAYPAL_AGENT_COPY.URL }),
    true,
  );
  assert.equal(call.clipboardWrites.at(-1), 'http://127.0.0.1:8000/v1');
  assert.equal(
    await call('desktopPaypalAgent', 'copy', { target: 'not-a-copy-target' }),
    false,
  );
});
void test('preview copies the actual synthetic payment reference for the selected session', async () => {
  const call = await fixture();
  const result = parsePaymentReferences(
    await call('desktopActivity', 'references'),
  );
  const reference = result.references[0];
  assert.ok(reference);
  assert.equal(
    await call('desktopActivity', 'copyReference', reference.sessionId),
    true,
  );
  assert.equal(call.clipboardWrites.at(-1), reference.id);
  assert.equal(
    await call('desktopActivity', 'copyReference', 'unknown-session'),
    false,
  );
});

void test('preview Vite configuration ignores synthetic local environment and configuration files', async () => {
  const { isolatePreviewBuild } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const { resolveConfig } = await import('vite');
  await writeFile(
    resolve(temporary, '.env.production'),
    'VITE_PREVIEW_REVIEW_CANARY=DO_NOT_BUNDLE\n',
  );
  await writeFile(
    resolve(temporary, 'vite.config.mjs'),
    "throw new Error('PREVIEW_CONFIG_MUST_NOT_RUN');\n",
  );
  const config = await resolveConfig(
    isolatePreviewBuild({ root: temporary }),
    'build',
  );
  assert.equal(config.env.VITE_PREVIEW_REVIEW_CANARY, undefined);
  assert.equal(config.configFile, undefined);
  assert.equal(config.envDir, false);
  assert.deepEqual(config.envPrefix, []);
});
void test('preview brand hooks normalize Windows module identifiers', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const theme = await readFile(
    new URL('../../apps/desktop/src/theme.ts', import.meta.url),
    'utf8',
  );
  const signal = await readFile(
    new URL('../../apps/desktop/src/ui/Signal.tsx', import.meta.url),
    'utf8',
  );
  const desktop = 'C:\\repo\\apps\\desktop';
  assert.match(
    transformBrand(theme, 'C:/repo/apps/desktop/src/theme.ts', desktop) ?? '',
    /#141414/,
  );
  assert.match(
    transformBrand(signal, 'C:/repo/apps/desktop/src/ui/Signal.tsx', desktop) ??
      '',
    /preview-brand-mark/,
  );
});
void test('preview brand hooks accept Windows CRLF source files', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const theme = await readFile(
    new URL('../../apps/desktop/src/theme.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    transformBrand(
      theme.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'),
      'C:/repo/apps/desktop/src/theme.ts',
      'C:/repo/apps/desktop',
    ) ?? '',
    /#141414/,
  );
});

void test('ten example chats share one spending limit and have individually attributable receipts', async () => {
  const call = await fixture('?screen=payments&review=ten-chats');
  const { archive } = parseChatArchiveLoad(
    await call('desktopConversations', 'load'),
  );
  const { summary } = parseX402Result(
    await call('desktopX402', 'run', { action: X402_ACTION.STATUS }),
  );
  const chats = archive?.sessions.filter((chat) => chat.messages.length) ?? [];
  assert.equal(chats.length, 10);
  assert.equal(summary.records.length, 10);
  for (const chat of chats) {
    assert.ok(
      summary.records.some(
        (record) =>
          record.sessionId === summary.sessionId &&
          chat.messages.some(
            (message) => message.id === record.id + '-assistant',
          ),
      ),
    );
  }
});
