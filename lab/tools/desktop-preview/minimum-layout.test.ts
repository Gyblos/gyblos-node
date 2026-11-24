import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { DESKTOP } from '@gyblos/desktop/window-chrome';

import { buildPreview } from './build';

void test('the desktop renderer fits its model picker and Limits controls at native minimum width', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-minimum-layout-'));
  try {
    const output = await buildPreview(join(root, 'dist'));
    const baseline = join(output, 'desktop');
    await copyFile(join(output, 'preview.js'), join(baseline, 'preview.js'));
    const probe = await readFile(
      new URL('./check-minimum-layout.mjs', import.meta.url),
      'utf8',
    );
    await writeFile(
      join(baseline, 'probe.mjs'),
      probe +
        '\ncheckMinimumLayout().catch((error) => {document.documentElement.dataset.layoutPassed = error.message;});',
    );
    const entry = join(baseline, 'index.html');
    const html = await readFile(entry, 'utf8');
    await writeFile(
      entry,
      html.replace(
        '<script type="module"',
        '<script src="./preview.js"></script><script type="module" src="./probe.mjs"></script><script type="module"',
      ),
    );
    const url = pathToFileURL(entry);
    url.search =
      'screen=chat&connection-state=ready&funding=ready&seller-budget=ready';
    const { stdout } = await promisify(execFile)(
      process.env.CHROME_BIN || 'google-chrome',
      [
        '--headless',
        '--disable-background-networking',
        '--no-first-run',
        '--allow-file-access-from-files',
        '--disable-extensions',
        '--hide-scrollbars',
        '--dump-dom',
        '--virtual-time-budget=12000',
        '--window-size=' + DESKTOP.MIN_WIDTH + ',900',
        '--user-data-dir=' + join(root, 'browser'),
        url.href,
      ],
      { timeout: 60000, maxBuffer: 2_000_000 },
    );
    assert.equal(
      /data-layout-passed="([^"]+)"/.exec(stdout)?.[1],
      String(DESKTOP.MIN_WIDTH),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
