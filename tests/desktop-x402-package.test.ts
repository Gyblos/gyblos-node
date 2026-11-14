// Packaging must include the buyer executable and exclude unrelated private artifacts.
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { stageDesktopAssets } from '@gyblos/desktop/package-assets';
import { DESKTOP_X402 } from '@gyblos/desktop/x402-model';

void test('desktop staging includes the buyer executable without copying private files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-assets-'));
  try {
    const dist = join(home, 'dist');
    const stage = join(home, 'stage');
    await mkdir(join(dist, 'renderer'), { recursive: true });
    await mkdir(stage);
    const files = [
      'main.cjs',
      'preload.cjs',
      'worker.cjs',
      'node-worker.cjs',
      DESKTOP_X402.SERVICE_FILE,
    ];
    for (const file of files) await writeFile(join(dist, file), file);
    await writeFile(join(dist, 'renderer/index.html'), 'renderer');
    await writeFile(join(dist, '.env'), 'synthetic-private');
    await stageDesktopAssets(dist, stage);
    assert.equal(
      await readFile(join(stage, DESKTOP_X402.SERVICE_FILE), 'utf8'),
      DESKTOP_X402.SERVICE_FILE,
    );
    assert.deepEqual(
      (await readdir(stage)).sort(),
      [...files, 'renderer'].sort(),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
