// Tests metadata-only persistence exclusively beneath temporary synthetic buyer homes.
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BUYER_SELECTION,
  BUYER_SELECTION_CODES,
} from '@gyblos/buyer/constants';
import { selectionStats } from '@gyblos/buyer/selection-stats';
import { homeLayout } from '@gyblos/config/home';

void test('selection stats use homeLayout, atomic private files and private buyer directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'selection-stats-'));
  try {
    const environment = { GYBLOS_HOME: directory };
    await mkdir(homeLayout(environment).roles.buyer, { recursive: true });
    const store = await selectionStats(environment);
    const row = {
      successes: 2,
      failures: 1,
      latencyMs: 12,
      waitAccuracy: null,
      cooldownUntil: null,
      quotedWaitMs: null,
      observedWaitMs: null,
    };
    store.rows.set('1'.repeat(64), row);
    await store.save();
    const buyer = homeLayout(environment).roles.buyer;
    const path = join(buyer, BUYER_SELECTION.statsFile);
    assert.equal((await stat(buyer)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    await store.save();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await selectionStats(environment)).rows.get('1'.repeat(64)),
      row,
    );
    assert.equal((await readFile(path, 'utf8')).includes('prompt'), false);
    await writeFile(
      path,
      JSON.stringify({
        rows: [
          {
            nodeId: '1'.repeat(64),
            stats: { ...row, prompt: 'private sentinel' },
          },
        ],
      }),
    );
    await assert.rejects(selectionStats(environment), {
      code: BUYER_SELECTION_CODES.INVALID,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
