// Owns offline private measurement row and salt regressions for @gyblos/node; no funded wallets or live services.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CHARGE_ANOMALIES } from '@gyblos/core/constants';
import { measurementRow, measurementSalt } from '@gyblos/node/measurements';

void test('invalid elapsed time never becomes infinite throughput', () => {
  const input = {
    requestId: 'id',
    seller: 'seller',
    offer: 'offer',
    channelId: 'channel',
    depositSignature: 'deposit',
    claimSignature: 'claim',
    ceilingAtomic: '10',
    chargedAtomic: '1',
    expectedAtomic: '1',
    differenceAtomic: '0',
    allowanceAtomic: '6',
    relativeDifference: 0,
    engineTokens: null,
    billedTokens: null,
    recountedTokens: { input: 0, output: 1 },
    countComparison: null,
    delivered: true,
    anomaly: CHARGE_ANOMALIES.NONE,
    responseText: 'answer',
  };
  for (const latencyMs of [0, -1, NaN, Infinity]) {
    const row = measurementRow({ ...input, latencyMs }, new Uint8Array(32));
    assert.equal(row.effectiveTokensPerSecond, null);
  }
});

void test('concurrent salt initializers cannot observe a partially written salt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-salt-race-'));
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 64 }, () => measurementSalt(directory)),
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      0,
    );
    const salts = results.map(
      (result) => (result as PromiseFulfilledResult<Buffer>).value,
    );
    for (const salt of salts) assert.deepEqual(salt, salts[0]);
    assert.equal(
      (await readFile(join(directory, 'measurement-salt'))).length,
      32,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('interrupted salt initialization never publishes an empty destination', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-salt-interruption-'));
  const original = fs.promises.open;
  fs.promises.open = (async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (String(args[0]).startsWith(directory) && args[1] === 'wx') {
      handle.writeFile = async () => {
        throw new Error('Injected write interruption');
      };
    }
    return handle;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      measurementSalt(directory),
      /Injected write interruption/,
    );
    await assert.rejects(readFile(join(directory, 'measurement-salt')), {
      code: 'ENOENT',
    });
  } finally {
    fs.promises.open = original;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('existing invalid salt is never silently regenerated', async () => {
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-salt-existing-'));
  try {
    await writeFile(join(directory, 'measurement-salt'), 'invalid');
    await assert.rejects(
      measurementSalt(directory),
      /Invalid local measurement salt/,
    );
    assert.equal(
      await readFile(join(directory, 'measurement-salt'), 'utf8'),
      'invalid',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
