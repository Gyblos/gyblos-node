// A lost registration acknowledgement cannot cause a second asset or submission.
// All signers and homes are synthetic; operations are injected and no network is used.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { OWNER_REGISTRATION_STATUS } from '@gyblos/identity/constants';
import { ROLE_CONFIG_SCHEMA_VERSION } from '@gyblos/node/constants';
import type { RoleConfig } from '@gyblos/node/roles';
import {
  registerSellerIdentity,
  sellerRegistrationOperations,
} from '@gyblos/node/seller-registration';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { addClaimant } from './support/identity-accounts';
import { fixedSigner } from './support/identity-fixture';
import { startFakeRpc } from './support/identity-rpc-fake';

void test('lost registration reply can resend only the identical signed attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyb-seller-registration-'));
  const environment = { GYBLOS_HOME: root };
  const identity = {
    owner: '11111111111111111111111111111112',
    nodeId: '01'.repeat(32),
  };
  const signer = await generateKeyPairSigner();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (item) => setTransactionMessageFeePayerSigner(signer, item),
    (item) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash('11111111111111111111111111111111'),
          lastValidBlockHeight: 100n,
        },
        item,
      ),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const prepared = {
    wire: getBase64EncodedWireTransaction(transaction),
    signature: getSignatureFromTransaction(transaction),
    lastValidBlockHeight: 100n,
  };
  let sends = 0;
  let builds = 0;
  let checks = 0;
  const sentWires: string[] = [];
  let checkStatus: 'unknown' | 'failed' = OWNER_REGISTRATION_STATUS.UNKNOWN;
  const assets: string[] = [];
  const operations = {
    lookup: async () => false,
    build: async (asset: Awaited<ReturnType<typeof generateKeyPairSigner>>) => {
      assets.push(asset.address);
      builds++;
      return { estimatedTotalLamports: 123n, sign: async () => prepared };
    },
    send: async (attempt: typeof prepared) => {
      sentWires.push(attempt.wire);
      sends++;
      const state = JSON.parse(
        await readFile(
          join(root, 'seller', 'registration-8004-v1.json'),
          'utf8',
        ),
      );
      assert.equal(state.prepared.signature, prepared.signature);
      return { status: OWNER_REGISTRATION_STATUS.UNKNOWN };
    },
    check: async () => {
      checks++;
      return { status: checkStatus };
    },
  };
  try {
    const args = {
      environment,
      identity,
      operations,
      confirm: async () => true,
    };
    assert.equal(await registerSellerIdentity(args), false);
    const saved = await readFile(
      join(root, 'seller', 'registration-8004-v1.json'),
      'utf8',
    );
    assert.equal(await registerSellerIdentity(args), false);
    assert.equal(
      await readFile(join(root, 'seller', 'registration-8004-v1.json'), 'utf8'),
      saved,
    );
    assert.equal(sends, 2);
    assert.equal(sentWires[0], sentWires[1]);
    assert.equal(builds, 2);
    assert.equal(checks, 1);
    checkStatus = OWNER_REGISTRATION_STATUS.FAILED;
    assert.equal(await registerSellerIdentity(args), false);
    assert.equal(sends, 3);
    assert.equal(builds, 4);
    assert.equal(assets[0], assets[3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('registration checks the on-chain owner, node binding and payout wallet', async () => {
  const fake = await startFakeRpc(new Map());
  try {
    const owner = await generateKeyPairSigner();
    const asset = await generateKeyPairSigner();
    const node = await fixedSigner(9);
    const nodeId = Buffer.from(
      getAddressEncoder().encode(node.address),
    ).toString('hex');
    const role: Extract<RoleConfig, { role: typeof P2P_ROLES.SELLER }> = {
      role: P2P_ROLES.SELLER,
      schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
      rpcUrl: fake.url,
      mint: owner.address,
      assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
      owner: owner.address,
      nodeId,
    };
    const operations = sellerRegistrationOperations({
      rpc: fake.rpc,
      environment: {},
      role,
    });
    assert.equal(await operations.lookup(), false);
    await addClaimant(fake.state.chain, {
      owner: owner.address,
      asset: asset.address,
      node,
    });
    assert.equal(await operations.lookup(asset.address), undefined);
    await addClaimant(fake.state.chain, {
      owner: owner.address,
      asset: asset.address,
      node,
      agentWallet: owner.address,
    });
    assert.equal(await operations.lookup(asset.address), true);
    const paid = sellerRegistrationOperations({
      rpc: fake.rpc,
      environment: {},
      role: {
        ...role,
        payTo: (await generateKeyPairSigner()).address,
        authorizer: (await generateKeyPairSigner()).address,
        facilitator: (await generateKeyPairSigner()).address,
        buyer: (await generateKeyPairSigner()).address,
      },
    });
    assert.equal(await paid.lookup(asset.address), true);
    assert.equal(
      await operations.lookup((await generateKeyPairSigner()).address),
      undefined,
    );
    const foreign = sellerRegistrationOperations({
      rpc: fake.rpc,
      environment: {},
      role: { ...role, owner: (await generateKeyPairSigner()).address },
    });
    assert.equal(await foreign.lookup(), undefined);
  } finally {
    await fake.close();
  }
});

void test('a price increase while the user decides requires fresh consent and sends nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyb-registration-cost-'));
  let builds = 0;
  let signs = 0;
  let sends = 0;
  let notified = 0;
  try {
    const result = await registerSellerIdentity({
      environment: { GYBLOS_HOME: root },
      identity: {
        owner: '11111111111111111111111111111112',
        nodeId: '01'.repeat(32),
      },
      operations: {
        lookup: async () => false,
        build: async () => {
          builds++;
          return {
            estimatedTotalLamports: BigInt(builds),
            sign: async () => {
              signs++;
              throw new Error('must not sign');
            },
          };
        },
        check: async () => ({ status: OWNER_REGISTRATION_STATUS.UNKNOWN }),
        send: async () => {
          sends++;
          return { status: OWNER_REGISTRATION_STATUS.UNKNOWN };
        },
      },
      confirm: async (cost) => cost === 1n,
      onCostChanged: () => {
        notified++;
      },
    });
    assert.equal(result, false);
    assert.equal(builds, 2);
    assert.equal(signs, 0);
    assert.equal(sends, 0);
    assert.equal(notified, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
