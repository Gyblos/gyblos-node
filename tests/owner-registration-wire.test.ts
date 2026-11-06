// Authenticates saved registration bytes with synthetic keys, including malicious but validly signed messages.
// No private state, RPC outside loopback, chain transactions or replacement signatures are used in verification.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import {
  buildOwnerRegistration,
  IDENTITY_ERROR_CODES,
  IdentityError,
  prepareOwnerRegistration,
  verifyPreparedOwnerRegistration,
} from '@gyblos/identity';
import { PROGRAMS, REGISTRATION_DEFAULTS } from '@gyblos/identity/constants';

import { fixedSigner } from './support/identity-fixture';
import { startFakeRpc } from './support/identity-rpc-fake';

void test('saved registration verifies both signatures and the canonical instruction/account sequence', async () => {
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: 100_000_000,
    ownerAfterProbe: 87_475_360,
    fee: 20_000,
  });
  try {
    const owner = await generateKeyPairSigner();
    const asset = await generateKeyPairSigner();
    const built = await buildOwnerRegistration({
      rpc: fake.rpc,
      owner,
      asset,
      node: await fixedSigner(1),
      agentUri: REGISTRATION_DEFAULTS.agentUri,
      bindingSequence: 1n,
    });
    const expected = {
      owner: owner.address,
      asset: asset.address,
      nodeId: built.nodeId,
    };
    const prepared = await prepareOwnerRegistration(built);
    await verifyPreparedOwnerRegistration(prepared, expected);
    const invalid = (error: unknown) =>
      error instanceof IdentityError &&
      error.code === IDENTITY_ERROR_CODES.INPUT_INVALID;
    for (const mismatch of [
      { ...expected, owner: asset.address },
      { ...expected, asset: owner.address },
      { ...expected, nodeId: '02'.repeat(32) },
    ])
      await assert.rejects(
        verifyPreparedOwnerRegistration(prepared, mismatch),
        invalid,
      );
    // Change an owner's or asset's signature while retaining a consistent first-signature field.
    for (const offset of [1, 65]) {
      const bytes = Buffer.from(prepared.wire, 'base64');
      bytes[offset] = bytes[offset]! ^ 1;
      const transaction = getTransactionDecoder().decode(bytes);
      await assert.rejects(
        verifyPreparedOwnerRegistration(
          {
            ...prepared,
            wire: getBase64EncodedWireTransaction(transaction),
            signature: getSignatureFromTransaction(transaction),
          },
          expected,
        ),
        invalid,
      );
    }
    const instructions = built.message.instructions;
    for (const changed of [
      [...instructions, instructions[0]!],
      [instructions[1]!, instructions[0]!, ...instructions.slice(2)],
      [
        { ...instructions[0]!, programAddress: PROGRAMS.system },
        ...instructions.slice(1),
      ],
      [
        instructions[0]!,
        {
          ...instructions[1]!,
          data: new Uint8Array(instructions[1]!.data!).fill(0),
        },
        ...instructions.slice(2),
      ],
      [
        instructions[0]!,
        instructions[1]!,
        {
          ...instructions[2]!,
          data: new Uint8Array(instructions[2]!.data!).fill(0),
        },
        instructions[3]!,
      ],
    ]) {
      const signed = await signTransactionMessageWithSigners({
        ...built.message,
        instructions: changed,
      });
      await assert.rejects(
        verifyPreparedOwnerRegistration(
          {
            ...prepared,
            wire: getBase64EncodedWireTransaction(signed),
            signature: getSignatureFromTransaction(signed),
          },
          expected,
        ),
        invalid,
      );
    }
    // Noncanonical/trailing encodings must not be interpreted as a shorter approved transaction.
    for (const wire of [
      prepared.wire + '=',
      Buffer.concat([
        Buffer.from(prepared.wire, 'base64'),
        Buffer.of(0),
      ]).toString('base64'),
    ]) {
      const changed = { ...prepared };
      Reflect.set(changed, 'wire', wire);
      await assert.rejects(
        verifyPreparedOwnerRegistration(changed, expected),
        invalid,
      );
    }
    assert.equal(fake.state.calls.includes('sendTransaction'), false);
  } finally {
    await fake.close();
  }
});
