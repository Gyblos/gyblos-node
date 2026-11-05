// Exercises owner-funded identity registration using synthetic signers and a loopback RPC.
// The node and wallet proofs are checked without funded keys or chain transactions.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner, getAddressEncoder } from '@solana/kit';

import {
  buildOwnerRegistration,
  detachedSignerFromNodeSecret,
  IDENTITY_ERROR_CODES,
  IdentityError,
} from '@gyblos/identity';
import { decodeBindingValue, verifyNodeBinding } from '@gyblos/identity/codec';
import { PROGRAMS } from '@gyblos/identity/constants';

import { fixedSigner } from './support/identity-fixture';
import { startFakeRpc } from './support/identity-rpc-fake';

const BALANCE = 100_000_000;
const RENT = 12_504_640;
const FEE = 20_000;

void test('the node secret produces the same detached signer and proof as its key pair', async () => {
  const fromSeed = await detachedSignerFromNodeSecret(
    new Uint8Array(32).fill(1),
  );
  const expected = await fixedSigner(1);
  const message = new TextEncoder().encode('synthetic node binding');
  assert.equal(fromSeed.address, expected.address);
  assert.deepEqual(
    await fromSeed.signDetached(message),
    await expected.signDetached(message),
  );
  await assert.rejects(
    detachedSignerFromNodeSecret(new Uint8Array(31)),
    (error: unknown) =>
      error instanceof IdentityError &&
      error.code === IDENTITY_ERROR_CODES.INPUT_INVALID,
  );
});

void test('the owner pays without prefunding and proves the owner wallet', async () => {
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: BALANCE,
    ownerAfterProbe: BALANCE - RENT - FEE,
    fee: FEE,
  });
  try {
    const owner = await generateKeyPairSigner();
    const asset = await generateKeyPairSigner();
    const node = await fixedSigner(1);
    const built = await buildOwnerRegistration({
      rpc: fake.rpc,
      owner,
      asset,
      node,
      agentUri: 'https://gyblos.com/n.json',
      bindingSequence: 1n,
    });
    assert.equal(built.message.feePayer.address, owner.address);
    assert.equal(built.message.instructions.length, 4);
    assert.deepEqual(
      built.message.instructions.map((item) => item.programAddress),
      [
        PROGRAMS.registry,
        PROGRAMS.registry,
        PROGRAMS.ed25519,
        PROGRAMS.registry,
      ],
    );
    const proof = built.message.instructions[2]?.data;
    assert.ok(proof);
    assert.deepEqual(
      proof.subarray(16, 48),
      new Uint8Array(getAddressEncoder().encode(owner.address)),
    );
    assert.equal(
      await crypto.subtle.verify(
        'Ed25519',
        owner.keyPair.publicKey,
        new Uint8Array(proof.subarray(48, 112)),
        new Uint8Array(proof.subarray(112)),
      ),
      true,
    );
    const metadata = built.message.instructions[1]?.data;
    assert.ok(metadata);
    const view = new DataView(
      metadata.buffer,
      metadata.byteOffset,
      metadata.byteLength,
    );
    const keyLength = view.getUint32(24, true);
    const valueLengthOffset = 28 + keyLength;
    const valueLength = view.getUint32(valueLengthOffset, true);
    const value = metadata.subarray(
      valueLengthOffset + 4,
      valueLengthOffset + 4 + valueLength,
    );
    const binding = decodeBindingValue(value);
    assert.equal(binding.nodeId, built.nodeId);
    assert.equal(
      await verifyNodeBinding(binding, asset.address, owner.address),
      true,
    );
    assert.equal(
      await verifyNodeBinding(binding, owner.address, asset.address),
      false,
    );
    assert.equal(built.feeLamports, BigInt(FEE));
    assert.equal(built.totalLamports, BigInt(RENT + FEE));
    assert.equal(
      built.nodeId,
      '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
    );
    assert.equal(
      fake.state.calls.filter((call) => call === 'simulateTransaction').length,
      1,
    );
    assert.equal(fake.state.calls.includes('sendTransaction'), false);
  } finally {
    await fake.close();
  }
});

void test('rejects an unexpected genesis before signing the node binding', async () => {
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: BALANCE,
    ownerAfterProbe: BALANCE - RENT - FEE,
    fee: FEE,
  });
  try {
    fake.state.genesisHash = '11111111111111111111111111111111';
    const original = await fixedSigner(1);
    let signed = 0;
    const node = {
      address: original.address,
      signDetached: async (message: Uint8Array) => {
        signed += 1;
        return original.signDetached(message);
      },
    };
    await assert.rejects(
      buildOwnerRegistration({
        rpc: fake.rpc,
        owner: await generateKeyPairSigner(),
        asset: await generateKeyPairSigner(),
        node,
        agentUri: 'https://gyblos.com/n.json',
        bindingSequence: 1n,
      }),
      (error: unknown) =>
        error instanceof IdentityError &&
        error.code === IDENTITY_ERROR_CODES.NETWORK_MISMATCH,
    );
    assert.equal(signed, 0);
    assert.equal(fake.state.calls.includes('sendTransaction'), false);
  } finally {
    await fake.close();
  }
});
