// Exercises signed owner registration transport against a local synthetic RPC.
// No transaction leaves the test process or reaches devnet.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import {
  buildOwnerRegistration,
  IDENTITY_ERROR_CODES,
  IdentityError,
} from '@gyblos/identity';

import { fixedSigner } from './support/identity-fixture';
import { startFakeRpc } from './support/identity-rpc-fake';

const BALANCE = 100_000_000;
const RENT = 12_504_640;
const FEE = 20_000;

void test('a signed registration can be saved before it is ever submitted', async () => {
  const { prepareOwnerRegistration } = await import('@gyblos/identity');
  assert.equal(typeof prepareOwnerRegistration, 'function');
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: BALANCE,
    ownerAfterProbe: BALANCE - RENT - FEE,
    fee: FEE,
  });
  try {
    const built = await buildOwnerRegistration({
      rpc: fake.rpc,
      owner: await generateKeyPairSigner(),
      asset: await generateKeyPairSigner(),
      node: await fixedSigner(1),
      agentUri: 'https://gyblos.com/n.json',
      bindingSequence: 1n,
    });
    const prepared = await prepareOwnerRegistration(built);
    assert.ok(prepared.signature);
    assert.ok(prepared.wire);
    assert.equal(prepared.lastValidBlockHeight, 100n);
    assert.equal(fake.state.calls.includes('sendTransaction'), false);
  } finally {
    await fake.close();
  }
});

void test('submitting the persisted signed bytes sends once and checks finality', async () => {
  const { prepareOwnerRegistration, submitOwnerRegistration } =
    await import('@gyblos/identity');
  assert.equal(typeof submitOwnerRegistration, 'function');
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: BALANCE,
    ownerAfterProbe: BALANCE - RENT - FEE,
    fee: FEE,
  });
  try {
    const built = await buildOwnerRegistration({
      rpc: fake.rpc,
      owner: await generateKeyPairSigner(),
      asset: await generateKeyPairSigner(),
      node: await fixedSigner(1),
      agentUri: 'https://gyblos.com/n.json',
      bindingSequence: 1n,
    });
    const prepared = await prepareOwnerRegistration(built);
    fake.state.sendSignature = prepared.signature;
    fake.state.signatureStatus = { confirmationStatus: 'finalized', err: null };
    const result = await submitOwnerRegistration({ rpc: fake.rpc, prepared });
    assert.equal(result.status, 'confirmed');
    assert.equal(
      fake.state.calls.filter((call) => call === 'sendTransaction').length,
      1,
    );
    const send = fake.state.configs.find(
      (call) => call.method === 'sendTransaction',
    );
    assert.equal(send?.params[0], prepared.wire);
  } finally {
    await fake.close();
  }
});

void test('owner registration bounds a slow RPC and never sends', async () => {
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: BALANCE,
    ownerAfterProbe: BALANCE - RENT - FEE,
    fee: FEE,
  });
  try {
    fake.state.delayMethods.set('getGenesisHash', 500);
    const input = {
      rpc: fake.rpc,
      owner: await generateKeyPairSigner(),
      asset: await generateKeyPairSigner(),
      node: await fixedSigner(1),
      agentUri: 'https://gyblos.com/n.json',
      bindingSequence: 1n,
      timeoutMs: 25,
    };
    await assert.rejects(
      Promise.race([
        buildOwnerRegistration(input),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('deadline missing')), 200),
        ),
      ]),
      (error: unknown) =>
        error instanceof IdentityError &&
        error.code === IDENTITY_ERROR_CODES.READ_TIMEOUT,
    );
    assert.equal(fake.state.calls.includes('sendTransaction'), false);
  } finally {
    await fake.close();
  }
});

void test('a non-cooperative RPC cannot send a registration after the deadline', async () => {
  const { prepareOwnerRegistration, submitOwnerRegistration } =
    await import('@gyblos/identity');
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: BALANCE,
    ownerAfterProbe: BALANCE - RENT - FEE,
    fee: FEE,
  });
  try {
    const built = await buildOwnerRegistration({
      rpc: fake.rpc,
      owner: await generateKeyPairSigner(),
      asset: await generateKeyPairSigner(),
      node: await fixedSigner(1),
      agentUri: 'https://gyblos.com/n.json',
      bindingSequence: 1n,
    });
    const prepared = await prepareOwnerRegistration(built);
    let sends = 0;
    const delayed = new Proxy(fake.rpc, {
      get(target, property) {
        if (property === 'getGenesisHash')
          return () => ({
            send: async () =>
              new Promise((resolve) =>
                setTimeout(() => resolve(fake.state.genesisHash), 200),
              ),
          });
        if (property === 'sendTransaction')
          return () => {
            sends++;
            return { send: async () => prepared.signature };
          };
        return Reflect.get(target, property);
      },
    });
    const outcome = await Promise.race([
      submitOwnerRegistration({ rpc: delayed, prepared, timeoutMs: 25 }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('deadline missing')), 100),
      ),
    ]);
    assert.deepEqual(outcome, { status: 'unknown' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(sends, 0);
  } finally {
    await fake.close();
  }
});
