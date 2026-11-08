// Read-only preflight is advisory: synthetic homes prove no writes and retain exclusive-save guards.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { FILE_MODES } from '@gyblos/config';
import { checkBuyerInit, initializeBuyer } from '@gyblos/node/buyer-init';
import { BUYER_INIT_CODES } from '@gyblos/node/buyer-init-constants';

import { answers, home, role } from './support/buyer-init';

void test('preflight returns the configured selection path without creating any state', async () => {
  const fixture = await home();
  try {
    assert.deepEqual(await checkBuyerInit(fixture.environment), { path: fixture.path, exists: false });
    assert.deepEqual(await readdir(fixture.directory), []);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

void test('preflight recognizes existing regular and dangling symlink destinations without opening them', async () => {
  const fixture = await home();
  try {
    await mkdir(dirname(fixture.path), { recursive: true, mode: FILE_MODES.privateDirectory });
    await writeFile(fixture.path, 'synthetic sentinel', { mode: FILE_MODES.privateFile });
    assert.deepEqual(await checkBuyerInit(fixture.environment), { path: fixture.path, exists: true });
    assert.equal(await readFile(fixture.path, 'utf8'), 'synthetic sentinel');
    await rm(fixture.path);
    const target = join(fixture.directory, 'missing-target');
    await symlink(target, fixture.path);
    assert.deepEqual(await checkBuyerInit(fixture.environment), { path: fixture.path, exists: true });
    assert.deepEqual((await readdir(fixture.directory)).sort(), ['home']);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

void test('preflight refuses a symlinked buyer directory without traversing or writing it', async () => {
  const fixture = await home();
  try {
    const outside = join(fixture.directory, 'outside');
    await mkdir(outside, { mode: FILE_MODES.privateDirectory });
    await mkdir(fixture.environment.GYBLOS_HOME, { mode: FILE_MODES.privateDirectory });
    await symlink(outside, dirname(fixture.path));
    await assert.rejects(checkBuyerInit(fixture.environment), { code: BUYER_INIT_CODES.UNAVAILABLE });
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

void test('a destination created after a clear preflight still refuses save before role preparation', async () => {
  const fixture = await home();
  let prepares = 0;
  try {
    assert.equal((await checkBuyerInit(fixture.environment)).exists, false);
    await mkdir(dirname(fixture.path), { recursive: true, mode: FILE_MODES.privateDirectory });
    await writeFile(fixture.path, 'synthetic concurrent settings', { mode: FILE_MODES.privateFile });
    await assert.rejects(initializeBuyer(answers(), {
      environment: fixture.environment,
      prepareRole: async () => { prepares++; return role(); },
    }), { code: BUYER_INIT_CODES.EXISTS });
    assert.equal(prepares, 0);
    assert.equal(await readFile(fixture.path, 'utf8'), 'synthetic concurrent settings');
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
