// Explicit user consent upgrades only the managed buyer's local policy.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { prepareDesktopBuyer } from '@gyblos/buyer/desktop-startup';
import { BUYER_SESSION_DEFAULT_POLICY } from '@gyblos/config/batch-session';

import { home, role } from './support/buyer-init';

void test('desktop applies an exact paid maximum and restores channel defaults for a legacy profile', async (t) => {
  const f = await home();
  t.after(() => rm(f.directory, {recursive: true, force: true}));
  const options = {environment: f.environment, prepareRole: async () => role()};
  await prepareDesktopBuyer(options);
  const initial = JSON.parse(await readFile(f.path, 'utf8'));
  const {session: _session, ...legacy} = initial;
  legacy.request.maxAtomic = '1';
  await writeFile(f.path, JSON.stringify(legacy));
  const maximum = '9007199254740993';
  await prepareDesktopBuyer(options, maximum);
  const updated = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(updated, {...legacy, request:{...legacy.request, maxAtomic: maximum}, session:BUYER_SESSION_DEFAULT_POLICY});
});
void test('invalid desktop paid maxima never rewrite the profile', async (t) => {
  const f = await home();
  t.after(() => rm(f.directory, {recursive: true, force: true}));
  const options = {environment: f.environment, prepareRole: async () => role()};
  await prepareDesktopBuyer(options);
  const previous = await readFile(f.path, 'utf8');
  for (const amount of ['0','1.1','18446744073709551616','-1']) {
    await assert.rejects(prepareDesktopBuyer(options,amount));
    assert.equal(await readFile(f.path, 'utf8'),previous);
  }
});
