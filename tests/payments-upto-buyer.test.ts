// The production buyer client: its own ceiling, addresses and network refused before anything is
// written, one signature per request across a restart, failures after journaling leaving no entry
// behind, and receipts checked against the durable journal. Synthetic keys and hints; no network.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  generateKeyPairSigner,
  getBase58Decoder,
  type TransactionSigner,
} from '@solana/kit';
import {
  decodeUptoPayload,
  UPTO_ERROR_CODES,
  UptoError,
} from 'x402-upto-metered';

import {
  buyerJournalPathsIn,
  DEVNET,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import {
  createUptoPaymentClient,
  openUptoBuyerJournal,
  uptoSettlementView,
  type UptoBuyerJournal,
  type UptoPaymentClientOptions,
  type UptoSettlementView,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError, type PaymentTerms } from '@gyblos/protocol/payment';

import { hints } from './support/payment-upto';
import {
  JOURNAL_FAULTS,
  memoryJournal,
  type JournalFault,
} from './support/payment-upto-client';
import { newLedger } from './support/payment-upto-ledger';

const NOW = 1_800_000_000_000;
const DIGEST = 'ab'.repeat(32);
const code = (expected: string) => (error: unknown) =>
  error instanceof PaymentError && error.code === expected;
const address = async () => (await generateKeyPairSigner()).address;

// A signer that counts the transactions it was asked to sign.
async function countingSigner() {
  const signer = await generateKeyPairSigner();
  const counter = { signed: 0 };
  const counted: TransactionSigner = {
    address: signer.address,
    async signTransactions(transactions, config) {
      counter.signed += transactions.length;
      return signer.signTransactions(transactions, config);
    },
  };
  return { signer: counted, counter };
}

async function buyer(
  journal: UptoBuyerJournal,
  overrides: Partial<UptoPaymentClientOptions> = {},
) {
  const { signer, counter } = await countingSigner();
  const mint = await address();
  const options: UptoPaymentClientOptions = {
    payer: signer,
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
    ...overrides,
  };
  const terms: PaymentTerms = {
    network: DEVNET,
    mint,
    payTo: await address(),
    feePayer: await address(),
    authorizer: await address(),
    protocolFeeBps: PROTOCOL_FEE.bps,
    treasury: PROTOCOL_FEE.treasury,
    buyer: options.payer.address,
    requestDigest: DIGEST,
    maxAtomic: '1000',
    expiresAt: NOW + 60_000,
  };
  return { options, terms, counter, client: createUptoPaymentClient(options) };
}

const memory = (fault: JournalFault = JOURNAL_FAULTS.NONE) =>
  memoryJournal(newLedger(NOW), fault, () => NOW);

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-buyer-client-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const durable = (root: string, now = () => NOW) =>
  openUptoBuyerJournal({
    paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
    now,
  });

void test('a request is signed once, even by the same buyer after a restart', () =>
  withRoot(async (root) => {
    const first = await buyer(await durable(root));
    const authorization = await first.client.authorize(first.terms);
    assert.equal(first.counter.signed, 1);
    // The open's own slot and its blockhash lifetime are kept for reconciliation.
    const journaled = await first.options.journal.get(DIGEST);
    assert.equal(
      journaled?.openSlot,
      decodeUptoPayload(authorization).openSlot,
    );
    assert.equal(
      journaled?.lastValidBlockHeight,
      (await hints()).lastValidBlockHeight,
    );
    assert.deepEqual(journaled?.policy, {
      network: DEVNET,
      mint: first.options.policy.mint,
      treasury: first.options.policy.treasury,
      protocolFeeBps: first.options.policy.protocolFeeBps,
    });
    await first.options.journal.close();
    const journal = await durable(root);
    const again = createUptoPaymentClient({ ...first.options, journal });
    await assert.rejects(
      again.authorize(first.terms),
      code(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED),
    );
    assert.equal(first.counter.signed, 1);
    assert.deepEqual(await again.reconcile(), [
      {
        channelId: authorization.channelId,
        requestDigest: DIGEST,
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
      },
    ]);
    await journal.close();
  }));

void test('untrusted terms, another network or no RPC are refused before anything is written', async () => {
  const failing = (error: unknown) => async () => {
    throw error;
  };
  for (const [overrides, change, expected] of [
    [{}, { maxAtomic: '1001' }, PAYMENT_ERROR_CODES.UNTRUSTED_TERMS],
    [{}, { payTo: 'not an address' }, PAYMENT_ERROR_CODES.UNTRUSTED_TERMS],
    [
      { hints: failing(new UptoError(UPTO_ERROR_CODES.INVALID_TERMS)) },
      {},
      PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
    ],
    [
      { hints: failing(new UptoError(UPTO_ERROR_CODES.UNAVAILABLE)) },
      {},
      PAYMENT_ERROR_CODES.UNAVAILABLE,
    ],
  ] as const) {
    const journal = memory();
    const { client, terms, counter } = await buyer(journal, overrides);
    await assert.rejects(
      client.authorize({ ...terms, ...change }),
      code(expected),
    );
    assert.equal(journal.entries.size, 0);
    assert.equal(counter.signed, 0);
  }
  // The buyer never pays the fees of its own open, and each party is its own account.
  const journal = memory();
  const { client, terms } = await buyer(journal);
  for (const change of [
    { feePayer: terms.buyer },
    { payTo: terms.buyer },
    { payTo: terms.feePayer },
    { payTo: PROTOCOL_FEE.treasury },
  ])
    await assert.rejects(
      client.authorize({ ...terms, ...change }),
      code(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
    );
  assert.equal(journal.entries.size, 0);
});

void test('a failure after journaling drops the unsigned entry, leaving nothing to reconcile', async () => {
  const unsaved = memory(JOURNAL_FAULTS.SIGNED_WRITE);
  const saving = await buyer(unsaved);
  await assert.rejects(
    saving.client.authorize(saving.terms),
    code(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
  );
  assert.equal(unsaved.entries.size, 0);
  const journal = memory();
  const signing = await buyer(journal, {
    payer: {
      address: (await generateKeyPairSigner()).address,
      async signTransactions() {
        throw new Error('wallet locked');
      },
    },
  });
  await assert.rejects(
    signing.client.authorize(signing.terms),
    code(PAYMENT_ERROR_CODES.UNAVAILABLE),
  );
  assert.equal(journal.entries.size, 0);
  assert.deepEqual(await signing.client.reconcile(), []);
  // A write that landed despite reporting failure keeps its journaled open.
  const landed = memory(JOURNAL_FAULTS.SIGNED_WRITE_LANDS);
  const kept = await buyer(landed);
  const authorization = await kept.client.authorize(kept.terms);
  assert.equal(landed.entries.get(DIGEST)?.channelId, authorization.channelId);
});

void test('an unsigned entry left by a crash blocks its request until the terms expire', () =>
  withRoot(async (root) => {
    let now = NOW;
    const journal = await durable(root, () => now);
    const crashed = await buyer(journal, { now: () => now });
    await journal.put({
      requestDigest: DIGEST,
      channelId: null,
      payTo: crashed.terms.payTo,
      feePayer: crashed.terms.feePayer,
      maxAtomic: '1000',
      policy: null,
      openSlot: '1',
      lastValidBlockHeight: '100',
      expiresAt: crashed.terms.expiresAt,
      state: PAYMENT_CHANNEL_STATES.OPEN,
      chargedAtomic: null,
    });
    await assert.rejects(
      crashed.client.authorize(crashed.terms),
      code(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED),
    );
    assert.deepEqual(await crashed.client.reconcile(), []);
    // Any later write prunes it once the terms expired.
    now = crashed.terms.expiresAt;
    await journal.put({
      requestDigest: 'cd'.repeat(32),
      channelId: null,
      payTo: crashed.terms.payTo,
      feePayer: crashed.terms.feePayer,
      maxAtomic: '1',
      policy: null,
      openSlot: '1',
      lastValidBlockHeight: '100',
      expiresAt: now + 1,
      state: PAYMENT_CHANNEL_STATES.OPEN,
      chargedAtomic: null,
    });
    assert.equal(await journal.get(DIGEST), undefined);
    await journal.close();
  }));

void test('a receipt settles the durable entry once; an unreachable chain or journal is reported', () =>
  withRoot(async (root) => {
    let view: UptoSettlementView = async () => undefined;
    const journal = await durable(root);
    const paying = await buyer(journal, {
      confirm: (settlement, channel) => view(settlement, channel),
    });
    const authorization = await paying.client.authorize(paying.terms);
    const settlement = {
      channelId: authorization.channelId,
      chargedAtomic: '10',
      refundedAtomic: '990',
      sellerAtomic: '9',
      feeAtomic: '0',
      transaction: 't'.repeat(64),
    };
    view = async () => {
      throw new Error('rpc down');
    };
    await assert.rejects(
      paying.client.checkReceipt(authorization, settlement, '10'),
      code(PAYMENT_ERROR_CODES.UNAVAILABLE),
    );
    view = async ({ transaction: _transaction, ...shown }) => shown;
    await paying.client.checkReceipt(authorization, settlement, '10');
    assert.equal(
      (await journal.get(DIGEST))?.state,
      PAYMENT_CHANNEL_STATES.SETTLED,
    );
    await assert.rejects(
      paying.client.checkReceipt(authorization, settlement, '10'),
      code(PAYMENT_ERROR_CODES.ALREADY_SETTLED),
    );
    await journal.close();
    const unreadable = memory(JOURNAL_FAULTS.READS);
    const broken = await buyer(unreadable);
    await assert.rejects(
      broken.client.authorize(broken.terms),
      code(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
    );
    await assert.rejects(
      broken.client.checkReceipt(authorization, settlement, '10'),
      code(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
    );
  }));

void test('a policy the buyer could never honor is refused at construction', async () => {
  const { options } = await buyer(memory());
  for (const policy of [
    { ...options.policy, maxAtomic: 'all' },
    // Twenty digits, but above the chain's u64.
    { ...options.policy, maxAtomic: '9'.repeat(20) },
    { ...options.policy, mint: 'not an address' },
    { ...options.policy, treasury: '' },
  ])
    assert.throws(
      () => createUptoPaymentClient({ ...options, policy }),
      code(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
    );
});

void test('a receipt is checked against what the claim transaction itself paid', async () => {
  let shown: { owner: string; before: bigint; after: bigint }[] = [];
  let channel = '';
  const journal = memory();
  const parties = await buyer(journal);
  const view = uptoSettlementView(
    {
      getTransaction: () => ({
        send: async () => ({
          meta: {
            err: null,
            preTokenBalances: shown.map((flow) => ({
              mint: parties.terms.mint,
              owner: flow.owner,
              uiTokenAmount: { amount: String(flow.before) },
            })),
            postTokenBalances: shown.map((flow) => ({
              mint: parties.terms.mint,
              owner: flow.owner,
              uiTokenAmount: { amount: String(flow.after) },
            })),
          },
          transaction: { message: { accountKeys: [channel] } },
        }),
      }),
    },
    parties.options.policy,
    parties.options.payer,
  );
  const client = createUptoPaymentClient({ ...parties.options, confirm: view });
  const authorization = await client.authorize(parties.terms);
  channel = authorization.channelId;
  // The claim: 970 back to the buyer, 29 to the seller, 0 fee (floored), escrow emptied.
  shown = [
    { owner: channel, before: 1000n, after: 0n },
    { owner: parties.terms.buyer, before: 0n, after: 970n },
    { owner: parties.terms.payTo, before: 0n, after: 29n },
  ];
  const settlement = {
    channelId: channel,
    chargedAtomic: '30',
    refundedAtomic: '970',
    sellerAtomic: '29',
    feeAtomic: '0',
    transaction: getBase58Decoder().decode(new Uint8Array(64).fill(3)),
  };
  // A seller claiming more than the chain shows paid is refused.
  await assert.rejects(
    client.checkReceipt(
      authorization,
      { ...settlement, sellerAtomic: '30', feeAtomic: '0' },
      '30',
    ),
    code(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH),
  );
  await client.checkReceipt(authorization, settlement, '30');
  assert.equal(
    journal.entries.get(DIGEST)?.state,
    PAYMENT_CHANNEL_STATES.SETTLED,
  );
});
