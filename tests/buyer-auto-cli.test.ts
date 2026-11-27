import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import test from 'node:test';

import { setBuyerRenewalBudget } from '@gyblos/buyer/auto-settings';
import { buildBuyerInit, initializeBuyer } from '@gyblos/node/buyer-init';
import { withBuyerRuntime } from '@gyblos/node/buyer-runtime';

import { answers, home, role } from './support/buyer-init';

void test('the Auto CLI updates only discovery and explicit tariffs and refuses malformed changes', async (t) => {
  const fixture = await home();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const input = {
    ...answers(),
    sellerNodeId: '',
    sellerOwner: '',
    maxUsdc: '0.01',
  };
  await initializeBuyer(input, {
    environment: fixture.environment,
    prepareRole: async () => role(),
  });
  const read = () => readFile(fixture.path, 'utf8');
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', 'apps/buyer/src/bin.ts', 'auto', ...args],
      { env: { ...process.env, ...fixture.environment }, encoding: 'utf8' },
    );
  const before = buildBuyerInit(input);
  const enabled = run('0.052', '0.208');
  assert.equal(enabled.status, 0, enabled.stderr);
  const updated = await read();
  assert.deepEqual(JSON.parse(updated), {
    ...before,
    discovery: { ...before.discovery, paidAuto: true },
    request: {
      ...before.request,
      priceCeilings: {
        inputAtomicPerMtok: '52000',
        outputAtomicPerMtok: '208000',
      },
    },
  });
  assert.notEqual(run('-1', '1').status, 0);
  assert.equal(await read(), updated);
  assert.equal(run('off').status, 0);
  assert.deepEqual(JSON.parse(await read()).discovery, before.discovery);
});

void test('operator renewal budget persists only while the home is stopped', async (t) => {
  const fixture = await home();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await initializeBuyer(
    { ...answers(), maxUsdc: '0.01' },
    { environment: fixture.environment, prepareRole: async () => role() },
  );
  const read = async () => JSON.parse(await readFile(fixture.path, 'utf8'));
  const before = await read();
  await setBuyerRenewalBudget(fixture.environment, '3000000');
  assert.deepEqual(await read(), {
    ...before,
    session: { ...before.session, renewalBudgetAtomic: '3000000' },
  });
  const buyer = await withBuyerRuntime(fixture.environment, async () => ({
    close: async () => {},
  }));
  try {
    await assert.rejects(setBuyerRenewalBudget(fixture.environment, null), {
      code: 'BUYER_RUNTIME_UNAVAILABLE',
    });
  } finally {
    await buyer.close();
  }
  await setBuyerRenewalBudget(fixture.environment, null);
  assert.deepEqual(await read(), before);
});
