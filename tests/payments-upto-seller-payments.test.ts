// The seller's real-chain payment stack, assembled offline: it holds the ledger lock for its lifetime,
// refuses keys that do not sign for its description, makes the token accounts a claim pays into exist
// before it starts (or does not start), refuses a junk deposit before touching the chain, recovers an
// empty ledger and releases everything on close. RPC is a double; no network.
import assert from 'node:assert/strict';
import { lstat, rm } from 'node:fs/promises';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';

import { DEVNET, PROTOCOL_FEE, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import { openUptoSellerPayments } from '@gyblos/payments-upto';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import { directory, paths } from './support/payment-upto-file';
import { offline } from './support/upto-seller-rpc';

const SETTINGS = {
  tokenProgram: String(TOKEN_PROGRAM_ADDRESS),
  withdrawDelaySeconds: 60,
  maxTimeoutSeconds: 120,
};

async function setup(chain: Parameters<typeof offline>[0] = {}) {
  const root = await directory();
  const feePayer = await generateKeyPairSigner();
  const authorizer = await generateKeyPairSigner();
  const double = offline(chain);
  const description = {
    network: DEVNET,
    mint: (await generateKeyPairSigner()).address,
    payTo: (await generateKeyPairSigner()).address,
    feePayer: feePayer.address,
    authorizer: authorizer.address,
    protocolFeeBps: PROTOCOL_FEE.bps,
    treasury: PROTOCOL_FEE.treasury,
  };
  const options = {
    rpcUrl: 'https://rpc.invalid',
    description,
    settings: SETTINGS,
    feePayer,
    authorizer,
    paths: paths(root),
    cleanup: { intervalSecs: 3600, abandonGraceSecs: 30 },
    rpc: double.rpc,
    sleep: async () => undefined,
  };
  return { root, options, description, sent: double.sent };
}

void test('the stack holds the ledger for its lifetime and releases it on close', async () => {
  const { root, options, description } = await setup();
  try {
    const payments = await openUptoSellerPayments(options);
    assert.deepEqual(await payments.server.describe(), description);
    await payments.recover();
    // A second seller process on the same home is refused while the first runs.
    await assert.rejects(openUptoSellerPayments(options));
    await payments.close();
    const again = await openUptoSellerPayments(options);
    await again.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('keys that do not sign for the description are refused and leave no lock', async () => {
  const { root, options } = await setup();
  try {
    const other = await generateKeyPairSigner();
    for (const keys of [{ feePayer: other }, { authorizer: other }])
      await assert.rejects(
        openUptoSellerPayments({ ...options, ...keys }),
        (error) =>
          error instanceof PaymentError &&
          error.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
      );
    await (await openUptoSellerPayments(options)).close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('missing recipient token accounts are created before start; a seller that cannot create them does not start', async () => {
  for (const refuse of [false, true]) {
    const { root, options, sent } = await setup({ missing: true, refuse });
    try {
      if (refuse) {
        await assert.rejects(
          openUptoSellerPayments(options),
          (error) =>
            error instanceof PaymentError &&
            error.code === PAYMENT_ERROR_CODES.UNAVAILABLE,
        );
        assert.deepEqual(sent, []);
        // The ledger lock was released: a later start once the accounts exist is not refused.
        await (
          await openUptoSellerPayments({ ...options, rpc: offline().rpc })
        ).close();
      } else {
        await (await openUptoSellerPayments(options)).close();
        assert.equal(sent.length, 1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

void test('a deposit that is not a valid channel open is refused before any transaction', async () => {
  const { root, options, description } = await setup();
  try {
    const payments = await openUptoSellerPayments(options);
    const buyer = (await generateKeyPairSigner()).address;
    const terms = {
      ...description,
      buyer,
      requestDigest: 'ab'.repeat(32),
      maxAtomic: '1000',
      expiresAt: Date.now() + 60_000,
    };
    await assert.rejects(
      payments.server.admit(
        {
          channelId: (await generateKeyPairSigner()).address,
          payer: buyer,
          requestDigest: terms.requestDigest,
          maxAtomic: terms.maxAtomic,
          payload: Buffer.from('not an open').toString('base64'),
        },
        terms,
      ),
      PaymentError,
    );
    await payments.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('mainnet seller is disabled before opening a ledger or sending', async () => {
  const { root, options, sent } = await setup();
  try {
    await assert.rejects(
      openUptoSellerPayments({
        ...options,
        description: { ...options.description, network: SOLANA_MAINNET_CAIP2 },
      }).then(async (payments) => {
        await payments.close();
        return payments;
      }),
      (error) =>
        error instanceof PaymentError &&
        error.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
    );
    assert.deepEqual(sent, []);
    await assert.rejects(lstat(options.paths.directory), { code: 'ENOENT' });
    await (await openUptoSellerPayments(options)).close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('seller refuses a mismatched RPC before writing or sending', async () => {
  const { root, options } = await setup();
  const wrong = offline({ missing: true, genesis: 'wrong-chain' });
  try {
    await assert.rejects(
      openUptoSellerPayments({ ...options, rpc: wrong.rpc }).then(
        async (payments) => {
          await payments.close();
          return payments;
        },
      ),
      (error) =>
        error instanceof PaymentError &&
        error.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
    );
    assert.deepEqual(wrong.sent, []);
    await assert.rejects(lstat(options.paths.directory), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('seller refuses an unavailable genesis before writing or sending', async () => {
  const { root, options } = await setup();
  const double = offline({ missing: true });
  const rpc = {
    ...double.rpc,
    getGenesisHash: () => ({
      send: async () => {
        throw new Error('synthetic RPC error');
      },
    }),
  };
  try {
    await assert.rejects(
      openUptoSellerPayments({ ...options, rpc }),
      (error) =>
        error instanceof PaymentError &&
        error.code === PAYMENT_ERROR_CODES.UNAVAILABLE,
    );
    assert.deepEqual(double.sent, []);
    await assert.rejects(lstat(options.paths.directory), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
