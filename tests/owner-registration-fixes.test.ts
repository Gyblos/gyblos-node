// Regression cases for expired registration recovery, funding estimates, existing identities and saved wire.
// All keys, accounts and RPC responses are synthetic; no transaction reaches a chain.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  blockhash,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import {
  buildOwnerRegistration,
  checkOwnerRegistration,
  IdentityError,
} from '@gyblos/identity';
import { ROLE_CONFIG_SCHEMA_VERSION } from '@gyblos/node/constants';
import { sellerRegistrationOperations } from '@gyblos/node/seller-registration';
import { openSellerRegistrationState } from '@gyblos/node/seller-registration-state';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { addClaimant } from './support/identity-accounts';
import { fixedSigner } from './support/identity-fixture';
import { startFakeRpc } from './support/identity-rpc-fake';

void test('registration fix: expiry is a distinct result only after blockhash invalidity and finalized account absence', async () => {
  const fake = await startFakeRpc(new Map());
  try {
    fake.state.blockHeight = 101;
    fake.state.blockhashValid = false;
    const input = {
      rpc: fake.rpc,
      signature: signature(getBase58Decoder().decode(new Uint8Array(64))),
      lastValidBlockHeight: 100n,
      attempt: {
        asset: (await generateKeyPairSigner()).address,
        blockhash: blockhash('11111111111111111111111111111111'),
      },
    };
    assert.equal((await checkOwnerRegistration(input)).status, 'expired');
    assert.ok(fake.state.calls.includes('getTransaction'));
    assert.ok(fake.state.calls.includes('isBlockhashValid'));
    fake.state.blockhashValid = true;
    assert.equal((await checkOwnerRegistration(input)).status, 'unknown');
    fake.state.blockhashValid = false;
    fake.state.blockHeight = 100;
    assert.equal((await checkOwnerRegistration(input)).status, 'unknown');
  } finally {
    await fake.close();
  }
});

void test('registration fix: an unfunded owner receives a cost and missing amount before simulation', async () => {
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: 0,
    ownerAfterProbe: 0,
    fee: 20000,
    initialSimulationErr: 'InsufficientFundsForRent',
  });
  try {
    await assert.rejects(
      buildOwnerRegistration({
        rpc: fake.rpc,
        owner: await generateKeyPairSigner(),
        asset: await generateKeyPairSigner(),
        node: await fixedSigner(1),
        agentUri: 'https://gyblos.com/n.json',
        bindingSequence: 1n,
      }),
      (error: unknown) =>
        error instanceof IdentityError &&
        Reflect.get(error, 'estimatedTotalLamports') > 0n &&
        Reflect.get(error, 'missingLamports') > 0n,
    );
    assert.equal(fake.state.calls.includes('simulateTransaction'), false);
    assert.ok(fake.state.rentQueries.length > 0);
  } finally {
    await fake.close();
  }
});

void test('registration fix: an existing verified asset for the same owner and NodeId is accepted', async () => {
  const fake = await startFakeRpc(new Map());
  try {
    const owner = await generateKeyPairSigner();
    const node = await fixedSigner(7);
    const nodeId = Buffer.from(
      getAddressEncoder().encode(node.address),
    ).toString('hex');
    await addClaimant(fake.state.chain, {
      owner: owner.address,
      asset: (await generateKeyPairSigner()).address,
      node,
      agentWallet: owner.address,
    });
    const operations = sellerRegistrationOperations({
      rpc: fake.rpc,
      environment: {},
      role: {
        schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
        role: P2P_ROLES.SELLER,
        rpcUrl: fake.url,
        mint: owner.address,
        assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
        owner: owner.address,
        nodeId,
      },
    });
    assert.equal(
      await operations.lookup((await generateKeyPairSigner()).address),
      true,
    );
    assert.equal(fake.state.calls.includes('sendTransaction'), false);
  } finally {
    await fake.close();
  }
});

void test('registration fix: a signed non-registration wire cannot be persisted or resent as an approved attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyb-registration-wire-'));
  const owner = await generateKeyPairSigner();
  const key = generateKeyPairSync('ed25519').privateKey.export({
    format: 'jwk',
  });
  assert.ok(key.d && key.x);
  const assetSecret = [
    ...Buffer.from(key.d, 'base64url'),
    ...Buffer.from(key.x, 'base64url'),
  ];
  await createKeyPairSignerFromBytes(Uint8Array.from(assetSecret));
  const state = await openSellerRegistrationState(
    { GYBLOS_HOME: root },
    { owner: owner.address, nodeId: '01'.repeat(32) },
  );
  try {
    await state.create(assetSecret);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (value) => setTransactionMessageFeePayerSigner(owner, value),
      (value) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash('11111111111111111111111111111111'),
            lastValidBlockHeight: 100n,
          },
          value,
        ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    await assert.rejects(
      state.savePrepared({
        wire: getBase64EncodedWireTransaction(signed),
        signature: getSignatureFromTransaction(signed),
        lastValidBlockHeight: 100n,
      }),
    );
    assert.equal((await state.read())?.prepared, undefined);
  } finally {
    await state.close();
    await rm(root, { recursive: true, force: true });
  }
});

void test('registration recovery refuses partial, stale or unavailable finalized account evidence', async () => {
  const fake = await startFakeRpc(new Map());
  try {
    fake.state.blockHeight = 101;
    fake.state.blockhashValid = false;
    const input = {
      rpc: fake.rpc,
      signature: signature(getBase58Decoder().decode(new Uint8Array(64))),
      lastValidBlockHeight: 100n,
      attempt: {
        asset: (await generateKeyPairSigner()).address,
        blockhash: blockhash('11111111111111111111111111111111'),
      },
    };
    for (const evidence of [[null, {}, null], [null], []]) {
      fake.state.batchValue = evidence;
      assert.equal((await checkOwnerRegistration(input)).status, 'unknown');
    }
    fake.state.batchValue = [null, null, null];
    fake.state.accountsContextSlot = 99;
    assert.equal((await checkOwnerRegistration(input)).status, 'unknown');
    fake.state.accountsContextSlot = 100;
    fake.state.failingMethods.add('isBlockhashValid');
    assert.equal((await checkOwnerRegistration(input)).status, 'unknown');
    fake.state.failingMethods.clear();
    fake.state.signatureStatus = { confirmationStatus: 'confirmed', err: null };
    assert.equal((await checkOwnerRegistration(input)).status, 'unknown');
    fake.state.signatureStatus = null;
    fake.state.transactionResult = { meta: { err: null } };
    assert.equal((await checkOwnerRegistration(input)).status, 'unknown');
    fake.state.transactionResult = null;
    assert.equal((await checkOwnerRegistration(input)).status, 'expired');
    const accountCall = fake.state.configs.find(
      (entry) => entry.method === 'getMultipleAccounts',
    );
    assert.deepEqual(accountCall?.params[1], {
      minContextSlot: 100,
      encoding: 'base64',
    });
    assert.equal(fake.state.calls.includes('sendTransaction'), false);
  } finally {
    await fake.close();
  }
});

void test('pre-simulation estimate is reported first and cannot be lowered by a cheaper simulation', async () => {
  const fake = await startFakeRpc(new Map(), {
    ownerBalance: 100_000_000,
    ownerAfterProbe: 99_000_000,
    fee: 20_000,
  });
  let estimate = 0n;
  try {
    const built = await buildOwnerRegistration({
      rpc: fake.rpc,
      owner: await generateKeyPairSigner(),
      asset: await generateKeyPairSigner(),
      node: await fixedSigner(1),
      agentUri: 'https://gyblos.com/n.json',
      bindingSequence: 1n,
      onEstimate: (value) => {
        estimate = value;
        assert.equal(fake.state.calls.includes('simulateTransaction'), false);
      },
    });
    assert.equal(built.estimatedTotalLamports, estimate);
    assert.ok(estimate > 1_000_000n);
    assert.deepEqual(fake.state.rentQueries, [748, 332, 105]);
    assert.equal(fake.state.calls.includes('sendTransaction'), false);
  } finally {
    await fake.close();
  }
});
