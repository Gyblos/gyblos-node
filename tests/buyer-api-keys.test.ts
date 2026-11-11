// Synthetic key authorities use an in-memory private store, never wallets or network services.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buyerApiKeyPathsIn } from '@gyblos/config/home';
import { openBuyerApiKeys } from '@gyblos/node/buyer-api-key-storage';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';

const scope = {
  network: 'synthetic-network',
  mint: '1'.repeat(32),
  payer: '2'.repeat(32),
};
function storage() {
  let saved: string | undefined;
  return {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
    value: () => saved,
    replace: (text: string) => {
      saved = text;
    },
  };
}
const quote = (amount: string) => ({
  maxAtomic: amount,
  requestId: 'synthetic-request',
  requestDigest: 'a'.repeat(64),
  sellerNodeId: 'b'.repeat(64),
});
void test('a USDC API key reserves before spending and retains its lifetime cap across restart', async () => {
  const files = storage();
  const keys = await createBuyerApiKeys({ files, scope });
  const created = await keys.create('Coding tools', '100');
  assert.equal(keys.authenticate(created.secret), created.id);
  assert.doesNotMatch(files.value() ?? '', new RegExp(created.secret));
  const first = keys.operation(created.id);
  await first.reserve(quote('60'));
  assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '60');
  await first.complete('30', 'settled');
  await keys.close();
  const restored = await createBuyerApiKeys({ files, scope });
  assert.equal(restored.authenticate(created.secret), created.id);
  const next = restored.operation(created.id);
  await assert.rejects(next.reserve(quote('80')), /BUYER_KEY_LIMIT_REACHED/);
  await next.reserve(quote('70'));
  await next.complete('70', 'approved');
  assert.deepEqual(
    (await restored.snapshot()).keys.map((key) => [
      key.spentAtomic,
      key.settledAtomic,
      key.approvedAtomic,
      key.reservedAtomic,
    ]),
    [['100', '30', '70', '0']],
  );
  await assert.rejects(
    restored.operation(created.id).reserve(quote('1')),
    /BUYER_KEY_LIMIT_REACHED/,
  );
  const free = restored.operation(created.id);
  await free.reserve(quote('0'));
  await free.complete('0', 'settled');
  await restored.close();
});
void test('unknown paid reservations survive a restart and cannot be bypassed by creating another key', async () => {
  const files = storage();
  const keys = await createBuyerApiKeys({ files, scope });
  const first = await keys.create('Synthetic', '100');
  await keys.operation(first.id).reserve(quote('100'));
  await keys.close();
  const restored = await createBuyerApiKeys({ files, scope });
  assert.equal((await restored.snapshot()).blocked, true);
  await assert.rejects(
    restored.create('Replacement', '100'),
    /BUYER_KEY_NEEDS_REVIEW/,
  );
  assert.throws(() => restored.operation(first.id), /BUYER_KEY_NEEDS_REVIEW/);
  await restored.revoke(first.id);
  assert.equal(restored.authenticate(first.secret), undefined);
  assert.equal((await restored.snapshot()).keys[0]?.reservedAtomic, '100');
  await restored.close();
});
void test('a key cannot change asset binding, reset its cap, or erase a running obligation by revocation', async () => {
  const files = storage();
  const keys = await createBuyerApiKeys({ files, scope });
  const key = await keys.create('Synthetic', '50');
  const running = keys.operation(key.id);
  await running.reserve(quote('50'));
  await keys.revoke(key.id);
  assert.equal(running.signal.aborted, true);
  await running.complete('40', 'approved');
  assert.equal((await keys.snapshot()).keys[0]?.spentAtomic, '40');
  await keys.close();
  await assert.rejects(
    createBuyerApiKeys({ files, scope: { ...scope, payer: '3'.repeat(32) } }),
    /BUYER_KEY_NEEDS_REVIEW/,
  );
});
void test('quote authority shrinks with consumption and concurrent reservations, while free requests remain possible', async () => {
  const keys = await createBuyerApiKeys({ files: storage(), scope });
  const key = await keys.create('Synthetic', '100');
  const first = keys.operation(key.id);
  assert.equal(first.ceiling('1000'), '100');
  await first.reserve(quote('60'));
  const second = keys.operation(key.id);
  assert.equal(second.ceiling('1000'), '40');
  assert.equal(second.ceiling('10'), '10');
  await assert.rejects(second.reserve(quote('41')), /BUYER_KEY_LIMIT_REACHED/);
  await second.reserve(quote('40'));
  await second.complete('40', 'settled');
  await first.complete('60', 'approved');
  const free = keys.operation(key.id);
  assert.equal(free.ceiling('1000'), '0');
  await free.reserve(quote('0'));
  await free.complete('0', 'settled');
  await keys.close();
});
void test('concurrent requests cannot reserve the same final allowance', async () => {
  const keys = await createBuyerApiKeys({ files: storage(), scope });
  const key = await keys.create('Synthetic', '100');
  const operations = Array.from({ length: 10 }, () => keys.operation(key.id));
  const results = await Promise.allSettled(
    operations.map((operation) => operation.reserve(quote('100'))),
  );
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '100');
  await keys.close();
});
void test('failed reservation and failed accounting writes fail closed without dispatch or renewed authority', async () => {
  for (const completed of [false, true]) {
    const files = storage();
    const keys = await createBuyerApiKeys({ files, scope });
    const key = await keys.create('Synthetic', '100');
    const operation = keys.operation(key.id);
    if (completed) await operation.reserve(quote('100'));
    files.write = async () => {
      throw new Error('synthetic disk failure');
    };
    await assert.rejects(
      completed
        ? operation.complete('60', 'settled')
        : operation.reserve(quote('100')),
      /BUYER_KEY_NEEDS_REVIEW/,
    );
    assert.equal((await keys.snapshot()).blocked, true);
    assert.throws(() => keys.operation(key.id), /BUYER_KEY_NEEDS_REVIEW/);
    await keys.close();
    const restored = await createBuyerApiKeys({ files, scope });
    assert.equal((await restored.snapshot()).blocked, completed);
    assert.equal(
      (await restored.snapshot()).keys[0]?.reservedAtomic,
      completed ? '100' : '0',
    );
    await restored.close();
  }
});
void test('noncanonical amounts and inconsistent durable key totals are rejected without replacing state', async () => {
  const files = storage();
  const keys = await createBuyerApiKeys({ files, scope });
  for (const value of ['-1', '01', '1.0', '1e6', ' 1', '9'.repeat(21)])
    await assert.rejects(keys.create('Synthetic', value));
  await keys.create('Synthetic', '100');
  await keys.close();
  const saved = files.value()!;
  files.replace(saved.replace('"spentAtomic":"0"', '"spentAtomic":"1"'));
  await assert.rejects(
    createBuyerApiKeys({ files, scope }),
    /BUYER_KEY_NEEDS_REVIEW/,
  );
  assert.notEqual(files.value(), saved);
});
void test('the private disk ledger locks concurrent hosts and reopens with original key consumption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-key-authority-'));
  const environment = { GYBLOS_HOME: join(directory, 'home') };
  await mkdir(join(environment.GYBLOS_HOME, 'buyer'), {
    recursive: true,
    mode: 0o700,
  });
  const keys = await openBuyerApiKeys(environment, scope);
  try {
    const key = await keys.create('Synthetic', '100');
    const operation = keys.operation(key.id);
    await operation.reserve(quote('100'));
    await operation.complete('30', 'settled');
    const paths = buyerApiKeyPathsIn(environment);
    assert.doesNotMatch(
      await readFile(paths.state, 'utf8'),
      new RegExp(key.secret),
    );
    assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
    await assert.rejects(openBuyerApiKeys(environment, scope));
    await keys.close();
    const restored = await openBuyerApiKeys(environment, scope);
    try {
      assert.equal(restored.authenticate(key.secret), key.id);
      assert.equal((await restored.snapshot()).keys[0]?.spentAtomic, '30');
    } finally {
      await restored.close();
    }
  } finally {
    await keys.close();
    await rm(directory, { recursive: true, force: true });
  }
});
