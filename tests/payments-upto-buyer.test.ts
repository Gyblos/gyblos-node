// The production buyer client with its durable journal: its own ceiling, another network or an
// unreachable RPC refused before anything is written, the journal surviving a restart (so a request is
// never signed twice), a tampered journal refused and one buyer process at a time. No network.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { UPTO_ERROR_CODES, UptoError } from 'x402-upto-metered';

import {
  buyerJournalPathsIn,
  DEVNET,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import {
  BUYER_JOURNAL,
  createUptoPaymentClient,
  openUptoBuyerJournal,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError, type PaymentTerms } from '@gyblos/protocol/payment';

import { hints } from './support/payment-upto';

const NOW = 1_800_000_000_000;
const DIGEST = 'ab'.repeat(32);

const code = (expected: string) => (error: unknown) =>
  error instanceof PaymentError && error.code === expected;

async function setup(root: string, hinted = hints) {
  const payer = await generateKeyPairSigner();
  const address = async () => (await generateKeyPairSigner()).address;
  const mint = await address();
  const journal = await openUptoBuyerJournal({
    paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
    now: () => NOW,
  });
  const client = createUptoPaymentClient({
    payer,
    policy: {
      network: DEVNET,
      mint,
      protocolFeeBps: PROTOCOL_FEE.bps,
      treasury: PROTOCOL_FEE.treasury,
      maxAtomic: '1000',
    },
    settings: UPTO_CHANNEL_SETTINGS,
    hints: hinted,
    journal,
    confirm: async () => undefined,
    now: () => NOW,
  });
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
  return { client, journal, terms, payer };
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-buyer-journal-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('a signed open is journaled with its channel and never signed again after a restart', () =>
  withRoot(async (root) => {
    const first = await setup(root);
    const authorization = await first.client.authorize(first.terms);
    assert.deepEqual(await first.journal.list(), [
      {
        requestDigest: DIGEST,
        channelId: authorization.channelId,
        maxAtomic: '1000',
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
        updatedAt: NOW,
      },
    ]);
    await first.journal.close();
    const restarted = await setup(root);
    const again = createUptoPaymentClient({
      payer: first.payer,
      policy: {
        network: DEVNET,
        mint: first.terms.mint,
        protocolFeeBps: PROTOCOL_FEE.bps,
        treasury: PROTOCOL_FEE.treasury,
        maxAtomic: '1000',
      },
      settings: UPTO_CHANNEL_SETTINGS,
      hints,
      journal: restarted.journal,
      confirm: async () => undefined,
      now: () => NOW,
    });
    await assert.rejects(
      again.authorize(first.terms),
      code(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED),
    );
    assert.deepEqual(
      (await again.reconcile()).map((entry) => entry.channelId),
      [authorization.channelId],
    );
    await restarted.journal.close();
  }));

void test('a deposit above the buyer ceiling, another network or no RPC writes nothing', () =>
  withRoot(async (root) => {
    for (const [hinted, terms, expected] of [
      [hints, { maxAtomic: '1001' }, PAYMENT_ERROR_CODES.UNTRUSTED_TERMS],
      [
        async () => {
          throw new UptoError(UPTO_ERROR_CODES.INVALID_TERMS);
        },
        {},
        PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
      ],
      [
        async () => {
          throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
        },
        {},
        PAYMENT_ERROR_CODES.UNAVAILABLE,
      ],
    ] as const) {
      const buyer = await setup(root, hinted);
      await assert.rejects(
        buyer.client.authorize({ ...buyer.terms, ...terms }),
        code(expected),
      );
      assert.deepEqual(await buyer.journal.list(), []);
      await buyer.journal.close();
    }
  }));

void test('one buyer process holds the journal; a tampered journal is refused', () =>
  withRoot(async (root) => {
    const buyer = await setup(root);
    await assert.rejects(
      setup(root),
      code(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
    );
    await buyer.client.authorize(buyer.terms);
    await buyer.journal.close();
    const { state } = buyerJournalPathsIn({ GYBLOS_HOME: root });
    for (const tampered of [
      '{"version":2,"entries":[]}',
      '{"version":1,"entries":[],"extra":1}',
      `{"version":1,"entries":[{"requestDigest":"${DIGEST}","channelId":null,"maxAtomic":"-1","state":"open","chargedAtomic":null,"updatedAt":1}]}`,
      `{"version":1,"entries":[{"requestDigest":"${DIGEST}","channelId":null,"maxAtomic":"1","state":"lost","chargedAtomic":null,"updatedAt":1}]}`,
    ]) {
      await writeFile(state, tampered, { mode: 0o600 });
      const reopened = await setup(root);
      await assert.rejects(
        reopened.journal.list(),
        code(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
      );
      await reopened.journal.close();
    }
  }));

void test('a full journal refuses new requests, keeps writing open ones and prunes old settled ones', () =>
  withRoot(async (root) => {
    let now = NOW;
    const journal = await openUptoBuyerJournal({
      paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
      now: () => now,
      maxEntries: 1,
    });
    const entry = {
      requestDigest: DIGEST,
      channelId: null,
      maxAtomic: '1000',
      state: PAYMENT_CHANNEL_STATES.OPEN,
      chargedAtomic: null,
      updatedAt: NOW,
    };
    await journal.put(entry);
    const other = { ...entry, requestDigest: 'cd'.repeat(32) };
    await assert.rejects(
      journal.put(other),
      code(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
    );
    // The open request still records its progress.
    await journal.put({
      ...entry,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: '5',
    });
    // Once settled long enough ago it is pruned, which frees room.
    now = NOW + BUYER_JOURNAL.settledRetentionMs;
    await journal.put(other);
    assert.deepEqual(
      (await journal.list()).map((held) => held.requestDigest),
      [other.requestDigest],
    );
    await journal.close();
  }));
