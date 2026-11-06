// Seller registration key loading uses its explicitly selected temporary home.
// The keys in this test are synthetic and never sent anywhere.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createKeyPairSignerFromBytes } from '@solana/kit';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { nodeSecret, roleSigner } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

void test('seller keys come from the specified home rather than the process home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyb-owner-role-'));
  const home = join(root, 'selected');
  const seller = join(home, 'seller');
  const other = join(root, 'other');
  const original = process.env.GYBLOS_HOME;
  try {
    await mkdir(seller, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    await chmod(seller, 0o700);
    await mkdir(other, { mode: 0o700 });
    const keys = generateKeyPairSync('ed25519');
    const jwk = keys.privateKey.export({ format: 'jwk' });
    assert.ok(jwk.d && jwk.x);
    const bytes = Uint8Array.from([
      ...Buffer.from(jwk.d, 'base64url'),
      ...Buffer.from(jwk.x, 'base64url'),
    ]);
    const signer = await createKeyPairSignerFromBytes(bytes);
    await writeFile(join(seller, 'owner.json'), JSON.stringify([...bytes]), {
      mode: 0o600,
    });
    await writeFile(
      join(seller, 'node.key'),
      JSON.stringify(Array(32).fill(7)),
      { mode: 0o600 },
    );
    await writeFile(
      join(seller, 'role.json'),
      JSON.stringify({
        schemaVersion: 1,
        role: 'seller',
        rpcUrl: 'https://example.invalid',
        mint: '11111111111111111111111111111112',
        assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
        nodeId: '01'.repeat(32),
        owner: signer.address,
      }),
    );
    process.env.GYBLOS_HOME = other;
    const environment = { GYBLOS_HOME: home };
    assert.equal(
      (await roleSigner(P2P_ROLES.SELLER, 'owner', environment)).address,
      signer.address,
    );
    assert.deepEqual(
      await nodeSecret(P2P_ROLES.SELLER, environment),
      Array(32).fill(7),
    );
  } finally {
    if (original === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = original;
    await rm(root, { recursive: true, force: true });
  }
});
