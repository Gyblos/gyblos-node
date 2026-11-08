// A role key is opened once without following a symbolic link, checked on that same descriptor (regular
// file, mode 0600, this user, bounded size) and read from it, so swapping the path between the check and
// the read can never make the node load another file (issue #21). Offline; synthetic keys only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { homeLayout, ROLE_FILES } from '@gyblos/config';
import { nodeSecret } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

const KEY = Array.from({ length: 32 }, (_, index) => index);
const OTHER = Array.from({ length: 32 }, () => 7);

async function withRoleHome(
  run: (paths: {
    key: string;
    outside: string;
    home: { GYBLOS_HOME: string };
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-role-key-'));
  const home = { GYBLOS_HOME: join(root, 'home') };
  const directory = homeLayout(home).roles[P2P_ROLES.SELLER];
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const outside = join(root, 'outside.json');
  writeFileSync(outside, JSON.stringify(OTHER), { mode: 0o600 });
  try {
    await run({ key: join(directory, ROLE_FILES.nodeKey), outside, home });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const read = (home: { GYBLOS_HOME: string }) =>
  nodeSecret(P2P_ROLES.SELLER, home);

void test('a private regular key file is read; a symbolic link, FIFO, loose mode or oversized file is refused', () =>
  withRoleHome(async ({ key, outside, home }) => {
    writeFileSync(key, JSON.stringify(KEY), { mode: 0o600 });
    assert.deepEqual(await read(home), KEY);
    chmodSync(key, 0o644);
    await assert.rejects(read(home), /permissions/);
    rmSync(key);
    symlinkSync(outside, key);
    await assert.rejects(read(home), /permissions/);
    rmSync(key);
    execFileSync('mkfifo', ['-m', '600', key]);
    // Refused without waiting for a writer.
    await assert.rejects(read(home), /permissions/);
    rmSync(key);
    writeFileSync(key, ' '.repeat(1 << 20), { mode: 0o600 });
    await assert.rejects(read(home), /permissions|Invalid role key/);
  }));

void test('swapping the key path for a symbolic link while reading never loads the link target', () =>
  withRoleHome(async ({ key, outside, home }) => {
    const real = `${key}.real`;
    const link = `${key}.link`;
    writeFileSync(key, JSON.stringify(KEY), { mode: 0o600 });
    let stop = false;
    // Alternates the path between the real key and a link to another valid key file.
    const swapper = (async () => {
      while (!stop) {
        writeFileSync(real, JSON.stringify(KEY), { mode: 0o600 });
        renameSync(real, key);
        await new Promise((resolve) => setImmediate(resolve));
        rmSync(link, { force: true });
        symlinkSync(outside, link);
        renameSync(link, key);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    try {
      for (let attempt = 0; attempt < 400; attempt++) {
        const result = await read(home).catch(() => undefined);
        assert.notDeepEqual(
          result,
          OTHER,
          `attempt ${attempt} read the link target`,
        );
      }
    } finally {
      stop = true;
      await swapper;
    }
  }));
