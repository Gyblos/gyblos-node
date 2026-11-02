// Mainnet remains locked and caller mutation cannot change the verified buyer policy or verifier.
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner, type TransactionSigner } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';

import {
  buyerJournalPathsIn,
  DEVNET,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import {
  createUptoPaymentClient,
  openUptoBuyerPayments,
  type UptoBuyerJournal,
  type UptoPaymentClientOptions,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError, type PaymentTerms } from '@gyblos/protocol/payment';

import { hints } from './support/payment-upto';
import { JOURNAL_FAULTS, memoryJournal } from './support/payment-upto-client';
import { newLedger } from './support/payment-upto-ledger';

const NOW = 1_800_000_000_000;
const DIGEST = 'ab'.repeat(32);
const code = (expected: string) => (error: unknown) =>
  error instanceof PaymentError && error.code === expected;
const address = async () => (await generateKeyPairSigner()).address;
const memory = () =>
  memoryJournal(newLedger(NOW), JOURNAL_FAULTS.NONE, () => NOW);

async function buyer(journal: UptoBuyerJournal) {
  const signer = await generateKeyPairSigner();
  const counter = { signed: 0 };
  const payer: TransactionSigner = {
    address: signer.address,
    async signTransactions(transactions, config) {
      counter.signed += transactions.length;
      return signer.signTransactions(transactions, config);
    },
  };
  const mint = await address();
  const options: UptoPaymentClientOptions = {
    payer,
    policy: {
      network: DEVNET,
      mint,
      protocolFeeBps: PROTOCOL_FEE.bps,
      treasury: PROTOCOL_FEE.treasury,
      maxAtomic: '1000',
    },
    settings: UPTO_CHANNEL_SETTINGS,
    hints,
    journal,
    confirm: async () => undefined,
    now: () => NOW,
  };
  const terms: PaymentTerms = {
    network: DEVNET,
    mint,
    payTo: await address(),
    feePayer: await address(),
    authorizer: await address(),
    protocolFeeBps: PROTOCOL_FEE.bps,
    treasury: PROTOCOL_FEE.treasury,
    buyer: payer.address,
    requestDigest: DIGEST,
    maxAtomic: '1000',
    expiresAt: NOW + 60_000,
  };
  return { options, terms, counter, client: createUptoPaymentClient(options) };
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-mainnet-buyer-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('mainnet buyer is disabled before journal writes or signatures', async () => {
  const journal = memory();
  const { options, counter } = await buyer(journal);
  assert.throws(
    () =>
      createUptoPaymentClient({
        ...options,
        policy: { ...options.policy, network: SOLANA_MAINNET_CAIP2 },
      }),
    code(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
  );
  assert.equal(journal.entries.size, 0);
  assert.equal(counter.signed, 0);
});

void test('mainnet buyer stack refuses before creating a journal or calling RPC', () =>
  withRoot(async (root) => {
    const { options } = await buyer(memory());
    const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
    await assert.rejects(
      openUptoBuyerPayments({
        rpcUrl: 'https://rpc.invalid',
        policy: { ...options.policy, network: SOLANA_MAINNET_CAIP2 },
        settings: options.settings,
        payer: options.payer,
        paths,
      }),
      code(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
    );
    await assert.rejects(lstat(paths.directory), { code: 'ENOENT' });
  }));

void test('mutating or replacing the buyer policy cannot enable mainnet', async () => {
  for (const replace of [false, true]) {
    const journal = memory();
    const { options, counter, client, terms } = await buyer(journal);
    if (replace)
      options.policy = { ...options.policy, network: SOLANA_MAINNET_CAIP2 };
    else options.policy.network = SOLANA_MAINNET_CAIP2;
    await assert.rejects(
      client.authorize({ ...terms, network: SOLANA_MAINNET_CAIP2 }),
      code(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
    );
    assert.equal(journal.entries.size, 0);
    assert.equal(counter.signed, 0);
  }
});

void test('replacing the receipt verifier cannot mark an unverified payment settled', async () => {
  const journal = memory();
  const { options, client, terms } = await buyer(journal);
  const authorization = await client.authorize(terms);
  options.confirm = async (settlement) => ({
    channelId: settlement.channelId,
    chargedAtomic: settlement.chargedAtomic,
    refundedAtomic: settlement.refundedAtomic,
    sellerAtomic: settlement.sellerAtomic,
    feeAtomic: settlement.feeAtomic,
  });
  const settlement = {
    channelId: authorization.channelId,
    chargedAtomic: '30',
    refundedAtomic: '970',
    sellerAtomic: '29',
    feeAtomic: '0',
    transaction: 'synthetic',
  };
  await assert.rejects(
    client.checkReceipt(authorization, settlement, '30'),
    code(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH),
  );
  assert.equal(journal.entries.get(DIGEST)?.state, PAYMENT_CHANNEL_STATES.OPEN);
});
