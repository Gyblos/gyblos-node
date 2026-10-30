// The synthetic registry must replay the exact signed binding, so conflict rejection cannot mask revocation.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { IDENTITY_LOOKUP_KINDS } from '@gyblos/core/identity-policy';
import { readRegistryIdentity } from '@gyblos/identity/resolution';
import { createIdentityResolutionRpc } from '@gyblos/identity/resolution-rpc';
import { IDENTITY_ACCEPTANCE } from '@gyblos/lab-harness/acceptance/identity-constants';
import { createAcceptanceRegistry } from '@gyblos/lab-harness/acceptance/identity-registry';

void test('synthetic registry restores the byte-identical signed binding after revocation', async () => {
  const registry = await createAcceptanceRegistry(new AbortController().signal);
  try {
    const keys = generateKeyPairSync('ed25519');
    const owner = await generateKeyPairSigner();
    const nodeId = Buffer.from(
      keys.publicKey.export({ format: 'jwk' }).x!,
      'base64url',
    ).toString('hex');
    await registry.bind(
      {
        nodeId,
        owner: owner.address,
        nodeSigner: async (bytes) =>
          new Uint8Array(sign(null, bytes, keys.privateKey)),
      },
      IDENTITY_ACCEPTANCE.initialSequence,
    );
    const rpc = createIdentityResolutionRpc(registry.url);
    const original = await readRegistryIdentity(rpc, nodeId);
    assert.equal(original.kind, IDENTITY_LOOKUP_KINDS.BOUND);
    const restore = registry.revoke(nodeId);
    assert.equal(
      (await readRegistryIdentity(rpc, nodeId)).kind,
      IDENTITY_LOOKUP_KINDS.MISSING,
    );
    assert.equal(typeof restore, 'function');
    restore();
    assert.deepEqual(await readRegistryIdentity(rpc, nodeId), original);
    await registry.close();
    assert.throws(restore, { code: 'ACCEPTANCE_FAILED' });
  } finally {
    await registry.close();
  }
});
