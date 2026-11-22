// Explicit user consent upgrades only the managed buyer's local policy.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { prepareDesktopBuyer } from '@gyblos/buyer/desktop-startup';
import { BUYER_SESSION_DEFAULT_POLICY } from '@gyblos/config/batch-session';

import { home, role } from './support/buyer-init';

void test('desktop applies an exact paid maximum and restores channel defaults for a legacy profile', async (t) => {
  const f = await home();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const options = {
    environment: f.environment,
    prepareRole: async () => role(),
  };
  await prepareDesktopBuyer(options);
  const initial = JSON.parse(await readFile(f.path, 'utf8'));
  const { session: _session, ...legacy } = initial;
  legacy.request.maxAtomic = '1';
  await writeFile(f.path, JSON.stringify(legacy));
  const maximum = '9007199254740993';
  await prepareDesktopBuyer(options, maximum);
  const updated = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(updated, {
    ...legacy,
    request: { ...legacy.request, maxAtomic: maximum },
    session: BUYER_SESSION_DEFAULT_POLICY,
  });
});
void test('invalid desktop paid maxima never rewrite the profile', async (t) => {
  const f = await home();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const options = {
    environment: f.environment,
    prepareRole: async () => role(),
  };
  await prepareDesktopBuyer(options);
  const previous = await readFile(f.path, 'utf8');
  for (const amount of ['0', '00', '1.1', '18446744073709551616', '-1']) {
    await assert.rejects(prepareDesktopBuyer(options, amount));
    assert.equal(await readFile(f.path, 'utf8'), previous);
  }
});

void test('desktop repairs an undersized deposit after confirmation and keeps independent pool limits', async (t) => {
  const f = await home();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const options = {
    environment: f.environment,
    prepareRole: async () => role(),
  };
  await prepareDesktopBuyer(options);
  const existing = JSON.parse(await readFile(f.path, 'utf8'));
  existing.session = {
    ...existing.session,
    depositAtomic: '1',
    totalDepositAtomic: '2000000',
  };
  await writeFile(f.path, JSON.stringify(existing));
  await prepareDesktopBuyer(options, '20000');
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).session, {
    ...BUYER_SESSION_DEFAULT_POLICY,
    totalDepositAtomic: '2000000',
  });
  existing.session.lifetimeMs = 'corrupt';
  const corrupted = JSON.stringify(existing);
  await writeFile(f.path, corrupted);
  await assert.rejects(prepareDesktopBuyer(options, '20000'));
  assert.equal(await readFile(f.path, 'utf8'), corrupted);
});

void test('Payments turns shared paid Auto on and off with exact prices and preserves the channel policy', async (t) => {
  const f = await home();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const options = {
    environment: f.environment,
    prepareRole: async () => role(),
  };
  await prepareDesktopBuyer(options);
  const before = JSON.parse(await readFile(f.path, 'utf8'));
  const rates = { inputAtomicPerMtok: '52000', outputAtomicPerMtok: '208000' };
  await assert.rejects(
    prepareDesktopBuyer(
      options,
      String(BigInt(before.session.depositAtomic) + 1n),
      rates,
    ),
    /deposit/i,
  );
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), before);
  await prepareDesktopBuyer(options, '10000', rates);
  const enabled = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(enabled.discovery.paidAuto, true);
  assert.deepEqual(enabled.request.priceCeilings, rates);
  assert.deepEqual(enabled.session, before.session);
  await prepareDesktopBuyer(options, '10000', null);
  const disabled = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(disabled.discovery.paidAuto, undefined);
  assert.deepEqual(disabled.request, enabled.request);
});
