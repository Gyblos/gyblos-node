// Seller registration persists its synthetic asset and signed attempt privately before sending.
// All homes in this test are temporary and no network is used.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openSellerRegistrationState } from '@gyblos/node/seller-registration-state';

void test('registration state is private, locked and retains one asset across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyb-register-state-'));
  const environment = { GYBLOS_HOME: root };
  const identity = {
    owner: '11111111111111111111111111111112',
    nodeId: '01'.repeat(32),
  };
  const key = generateKeyPairSync('ed25519').privateKey.export({
    format: 'jwk',
  });
  assert.ok(key.d && key.x);
  const secret = [
    ...Buffer.from(key.d, 'base64url'),
    ...Buffer.from(key.x, 'base64url'),
  ];
  try {
    const state = await openSellerRegistrationState(environment, identity);
    assert.ok(state);
    assert.equal(await state.read(), undefined);
    await state.create(secret);
    await assert.rejects(openSellerRegistrationState(environment, identity));
    const path = join(root, 'seller', 'registration-8004-v1.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await state.close();
    const reopened = await openSellerRegistrationState(environment, identity);
    assert.deepEqual((await reopened.read())?.assetSecret, secret);
    await assert.rejects(reopened.create(secret));
    await reopened.close();
    const foreign = await openSellerRegistrationState(environment, {
      ...identity,
      nodeId: '02'.repeat(32),
    });
    await assert.rejects(foreign.read());
    await foreign.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
