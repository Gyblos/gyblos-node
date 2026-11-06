// Checks owner-funded registration results using a synthetic local RPC only.
// No transaction is sent to a network or a funded wallet.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getBase58Decoder, signature } from '@solana/kit';

import * as identity from '@gyblos/identity';

import { startFakeRpc } from './support/identity-rpc-fake';

const syntheticSignature = signature(
  getBase58Decoder().decode(new Uint8Array(64)),
);

void test('registration result requires finalized status and searches transaction history', async () => {
  const check = Reflect.get(identity, 'checkOwnerRegistration');
  assert.equal(typeof check, 'function');
  const fake = await startFakeRpc(new Map());
  try {
    fake.state.signatureStatus = { confirmationStatus: 'finalized', err: null };
    const result = await check({
      rpc: fake.rpc,
      signature: syntheticSignature,
      lastValidBlockHeight: 100n,
    });
    assert.equal(result.status, 'confirmed');
    const call = fake.state.configs.find(
      (item) => item.method === 'getSignatureStatuses',
    );
    assert.deepEqual(call?.params[1], { searchTransactionHistory: true });
    fake.state.signatureStatus = {
      confirmationStatus: 'finalized',
      err: { InstructionError: [0, 'Custom'] },
    };
    assert.equal(
      (
        await check({
          rpc: fake.rpc,
          signature: syntheticSignature,
          lastValidBlockHeight: 100n,
        })
      ).status,
      'failed',
    );
    fake.state.signatureStatus = { confirmationStatus: 'confirmed', err: null };
    assert.equal(
      (
        await check({
          rpc: fake.rpc,
          signature: syntheticSignature,
          lastValidBlockHeight: 100n,
        })
      ).status,
      'unknown',
    );
    fake.state.signatureStatus = { confirmationStatus: 'finalized' };
    assert.equal(
      (
        await check({
          rpc: fake.rpc,
          signature: syntheticSignature,
          lastValidBlockHeight: 100n,
        })
      ).status,
      'unknown',
    );
    fake.state.signatureStatus = null;
    assert.equal(
      (
        await check({
          rpc: fake.rpc,
          signature: syntheticSignature,
          lastValidBlockHeight: 1n,
        })
      ).status,
      'unknown',
    );
  } finally {
    await fake.close();
  }
});
