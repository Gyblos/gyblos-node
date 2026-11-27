import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { PAYPAL_ACTION } from '@gyblos/desktop/paypal-model';
import { DESKTOP } from '@gyblos/desktop/window-chrome';
import { X402_ACTION } from '@gyblos/desktop/x402-model';
import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';
import { MODEL_IDS } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { buildPreview } from './build';
import { PREVIEW_FAILURE } from './constants';

async function render(
  root: string,
  url: URL,
  width: number,
  reduceMotion = false,
) {
  const { stdout } = await promisify(execFile)(
    process.env.CHROME_BIN || 'google-chrome',
    [
      '--headless',
      ...(reduceMotion ? ['--force-prefers-reduced-motion'] : []),
      '--disable-background-networking',
      '--no-first-run',
      '--allow-file-access-from-files',
      '--disable-extensions',
      '--hide-scrollbars',
      '--dump-dom',
      '--virtual-time-budget=12000',
      '--window-size=' + width + ',900',
      '--user-data-dir=' + join(root, 'browser'),
      url.href,
    ],
    { timeout: 60000, maxBuffer: 2_000_000 },
  );
  return stdout;
}

async function minimumLayout(
  head = '',
  probeName = 'check-minimum-layout.ts',
  invoke = 'checkMinimumLayout()',
  reduceMotion = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-minimum-layout-'));
  try {
    const output = await buildPreview(join(root, 'dist'));
    const baseline = join(output, 'desktop');
    await copyFile(join(output, 'preview.js'), join(baseline, 'preview.js'));
    const probe = await readFile(new URL(probeName, import.meta.url), 'utf8');
    await writeFile(
      join(baseline, 'probe.mjs'),
      stripTypeScriptTypes(probe) +
        '\n' +
        invoke +
        '.catch((error) => {document.documentElement.dataset.layoutPassed = error.message;});',
    );
    const entry = join(baseline, 'index.html');
    const html = await readFile(entry, 'utf8');
    await writeFile(
      entry,
      html.replace(
        '<script type="module"',
        head +
          '<script src="./preview.js"></script><script type="module" src="./probe.mjs"></script><script type="module"',
      ),
    );
    const url = pathToFileURL(entry);
    url.search =
      'screen=chat&connection-state=ready&funding=ready&seller-budget=ready';
    const stdout = await render(root, url, DESKTOP.MIN_WIDTH, reduceMotion);
    return {
      passed: /data-layout-passed="([^"]+)"/.exec(stdout)?.[1],
      skipped: /data-inert-payment-rows="([^"]+)"/.exec(stdout)?.[1],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('the desktop renderer fits its model picker and Limits controls at native minimum width', async () => {
  assert.equal((await minimumLayout()).passed, String(DESKTOP.MIN_WIDTH));
});

void test('the minimum-width probe measures the live pane while a slide snapshot is still entering', async () => {
  const { passed, skipped } = await minimumLayout(
    '<style>.slide-snapshot--in{animation-play-state:paused!important;animation-delay:-150ms!important}.slide-snapshot button[aria-label]{scale:2!important}</style>',
  );
  assert.equal(passed, String(DESKTOP.MIN_WIDTH));
  assert.ok(Number(skipped) > 0);
});

void test('the design-system dialog hides the action tooltip while its label is visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-dialog-action-'));
  try {
    const output = await buildPreview(join(root, 'dist'));
    const probe = await readFile(
      new URL('./check-minimum-layout.ts', import.meta.url),
      'utf8',
    );
    await writeFile(
      join(output, 'probe.mjs'),
      stripTypeScriptTypes(probe) +
        '\ncheckWideDialogAction().catch((error) => {document.documentElement.dataset.layoutPassed = error.message;});',
    );
    const entry = join(output, 'index.html');
    const html = await readFile(entry, 'utf8');
    await writeFile(
      entry,
      html.replace(
        '<script type="module"',
        '<script type="module" src="./probe.mjs"></script><script type="module"',
      ),
    );
    const url = pathToFileURL(entry);
    url.search = 'screen=settings&review=buttons';
    const width = 1280;
    assert.equal(
      /data-layout-passed="([^"]+)"/.exec(await render(root, url, width))?.[1],
      String(width),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a restored USDC failure renders one recovery explanation and preserves the next draft at minimum width', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-failed-turn-'));
  try {
    const output = await buildPreview(join(root, 'dist'));
    const url = pathToFileURL(join(output, 'index.html'));
    for (const theme of ['light', 'dark']) {
      url.search = new URLSearchParams({
        screen: 'chat',
        review: PREVIEW_FAILURE.SHARED,
        theme,
      }).toString();
      const html = await render(root, url, DESKTOP.MIN_WIDTH);
      const turn = html.match(
        /<article class="chat-answer".*?<\/article>/s,
      )?.[0];
      assert.ok(turn);
      assert.equal(turn.match(/role="status"/g)?.length, 1);
      assert.match(turn, /final charge is unknown/);
      assert.match(turn, /paused Desktop and connected tools/);
      assert.match(turn, /<button[^>]*>Check status<\/button>/);
      assert.doesNotMatch(turn, /Response unavailable/);
      assert.match(html, /How should I handle an empty file\?/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const example of [
  PREVIEW_FAILURE.SHARED,
  PREVIEW_FAILURE.STOP,
  PREVIEW_FAILURE.PAYPAL,
  PREVIEW_FAILURE.DECLINED,
  PREVIEW_FAILURE.EXPIRED,
  PREVIEW_FAILURE.SHARED_UNSENT,
  PREVIEW_FAILURE.PARTIAL_LIMIT,
  PREVIEW_FAILURE.EMPTY_LIMIT,
  PREVIEW_FAILURE.OTHER_TURN,
  PREVIEW_FAILURE.REVIEW_ERROR,
]) {
  const proof =
    example === PREVIEW_FAILURE.OTHER_TURN
      ? 'other-turn'
      : example === PREVIEW_FAILURE.REVIEW_ERROR
        ? 'error'
        : undefined;
  const review = proof ? PREVIEW_FAILURE.INTERRUPTED : example;
  void test(`shipped chat preserves independent recovery actions for ${example}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-failed-turn-'));
    try {
      const preview = await buildPreview(join(root, 'dist'));
      const output = join(preview, 'desktop');
      await copyFile(join(preview, 'preview.js'), join(output, 'preview.js'));
      const probe = await readFile(
        new URL('./check-failed-turn.ts', import.meta.url),
        'utf8',
      );
      await writeFile(
        join(output, 'probe.mjs'),
        stripTypeScriptTypes(probe) +
          `\ncheckFailedTurn(${JSON.stringify(PREVIEW_FAILURE)}, ${JSON.stringify(X402_ACTION.SEND)}, ${JSON.stringify(X402_ACTION.REVIEW)}, ${JSON.stringify(PAYPAL_ACTION.SEND)}).catch(error => { document.documentElement.dataset.recoveryPassed = error.message; });`,
      );
      const entry = join(output, 'index.html');
      const html = await readFile(entry, 'utf8');
      await writeFile(
        entry,
        html.replace(
          '<script type="module"',
          '<script src="./preview.js"></script><script type="module" src="./probe.mjs"></script><script type="module"',
        ),
      );
      const url = pathToFileURL(entry);
      url.search = new URLSearchParams({
        screen: 'chat',
        review,
        ...(proof && { 'status-proof': proof }),
      }).toString();
      const result = await render(root, url, DESKTOP.MIN_WIDTH);
      assert.equal(/data-recovery-passed="([^"]+)"/.exec(result)?.[1], 'yes');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
void test('confirmed paid Chat keeps the draft during a fresh seller check and manually recovers late evidence', async () => {
  const args = [
    SESSION_CODES.CLOSED,
    BUYER_KEY_CODES.REVIEW,
    X402_ACTION.REVIEW,
    X402_ACTION.SEND,
  ];
  const result = await minimumLayout(
    '',
    'check-pinned-seller.ts',
    'checkPinnedSeller(...' + JSON.stringify(args) + ')',
    true,
  );
  assert.equal(result.passed, 'verified');
});

void test('a free profile without session terms configures paid Chat before checking and confirming the seller', async () => {
  const args = [
    SESSION_CODES.CLOSED,
    BUYER_KEY_CODES.REVIEW,
    X402_ACTION.REVIEW,
    X402_ACTION.SEND,
    X402_ACTION.CONFIGURE_PAID,
  ];
  const result = await minimumLayout(
    '',
    'check-pinned-seller.ts',
    'checkPinnedSeller(...' + JSON.stringify(args) + ')',
    true,
  );
  assert.equal(result.passed, 'verified');
});

for (const [description, input, output, affordable, partial, evidence] of [
  ['refuses input above the limit', '100001', '200000', false, false],
  ['refuses output above the limit', '100000', '200001', false, false],
  ['sends at both limits', '100000', '200000', true, false],
  [
    'finds an affordable seller after a partial first page',
    '100000',
    '200000',
    true,
    true,
  ],
  [
    'preserves the draft after a partial lookup',
    '100001',
    '200000',
    false,
    true,
  ],
  [
    'keeps Chat available with zero wallet funds and partial listings',
    '100000',
    '200000',
    true,
    true,
    'zero',
  ],
  [
    'keeps Chat available with unknown funds and partial listings',
    '100000',
    '200000',
    true,
    true,
    'unknown',
  ],
  [
    'uses a free later listing without a funding read',
    '100000',
    '200000',
    true,
    true,
    'free',
  ],
] as const)
  void test(`the desktop Auto picker ${description} with verified switching credit`, async () => {
    const args = [
      MODEL_IDS.QWEN3_0_6B,
      input,
      output,
      affordable,
      SESSION_CODES.REPLACEMENT_REQUIRED,
      X402_ACTION.SEND,
      partial,
      evidence,
    ];
    const result = await minimumLayout(
      '',
      'check-auto-seller.ts',
      'checkAutoSeller(window.desktopCatalog, ...' + JSON.stringify(args) + ')',
      true,
    );
    assert.equal(result.passed, 'verified');
  });
