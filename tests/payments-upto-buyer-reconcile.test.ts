// The buyer's reconciliation from finalized history: an untouched channel address is open until its
// open can no longer land, then never opened; a claim that emptied the escrow settles, disputes or is
// unchecked against the buyer's own count; anything else stays open. Temporary journal; RPC double.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { signature as asSignature, getBase58Decoder } from '@solana/kit';
import { UPTO_ERROR_CODES, UptoError } from 'x402-upto-metered';

import { buyerJournalPathsIn } from '@gyblos/config';
import {
  BUYER_RECONCILE,
  openUptoBuyerJournal,
  RECONCILE_OUTCOMES,
  reconcileUptoBuyer,
  type UptoBuyerJournal,
  type UptoReconcileOptions,
} from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

const NOW = 1_800_000_000_000;
const MINT = 'Mint111111111111111111111111111111111111111';
const CHANNEL = 'Chan111111111111111111111111111111111111111';
const PAYER = 'Payer11111111111111111111111111111111111111';
const PAY_TO = 'PayTo11111111111111111111111111111111111111';
const FEE_PAYER = 'FeePa11111111111111111111111111111111111111';
const TREASURY = 'Treas11111111111111111111111111111111111111';
const DIGEST = 'ab'.repeat(32);
const signature = (fill: number) =>
  getBase58Decoder().decode(new Uint8Array(64).fill(fill));
const OPEN_TX = signature(1);
const CLAIM_TX = signature(2);

// The open moved 1000 into the escrow; the claim paid 9 out, 0 fee, and refunded 991.
function transactionFor(transaction: string) {
  const balances = (pairs: [string, bigint][]) =>
    pairs.map(([owner, amount], index) => ({
      accountIndex: index,
      mint: MINT,
      owner,
      uiTokenAmount: { amount: String(amount) },
    }));
  const claim = transaction === CLAIM_TX;
  return {
    meta: {
      err: null,
      preTokenBalances: balances(
        claim
          ? [
              [CHANNEL, 1000n],
              [PAY_TO, 0n],
              [PAYER, 0n],
            ]
          : [[PAYER, 1000n]],
      ),
      postTokenBalances: balances(
        claim
          ? [
              [CHANNEL, 0n],
              [PAY_TO, 9n],
              [PAYER, 991n],
            ]
          : [
              [CHANNEL, 1000n],
              [PAYER, 0n],
            ],
      ),
    },
    transaction: { message: { accountKeys: [PAYER, CHANNEL] } },
  };
}

// Newest first, as the RPC lists them; `failing` makes every read reject.
function chain(history: string[], failing = false) {
  const commitments: string[] = [];
  const rpc: UptoReconcileOptions['rpc'] = {
    getSignaturesForAddress: (_account, config) => ({
      send: async () => {
        commitments.push(config.commitment);
        if (failing) throw new Error('rpc down at https://rpc.example/?key=s');
        return [...history]
          .reverse()
          .map((each) => ({ signature: asSignature(each), err: null }));
      },
    }),
    getTransaction: (found, config) => ({
      send: async () => {
        commitments.push(config.commitment);
        return transactionFor(String(found));
      },
    }),
  };
  return { rpc, commitments };
}

async function withJournal(run: (journal: UptoBuyerJournal) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-buyer-reconcile-'));
  const journal = await openUptoBuyerJournal({
    paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
    now: () => NOW,
  });
  try {
    await journal.put({
      requestDigest: DIGEST,
      channelId: CHANNEL,
      payTo: PAY_TO,
      feePayer: FEE_PAYER,
      maxAtomic: '1000',
      expiresAt: NOW + 60_000,
      state: PAYMENT_CHANNEL_STATES.OPEN,
      chargedAtomic: null,
    });
    await run(journal);
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

const reconcile = (
  journal: UptoBuyerJournal,
  rpc: UptoReconcileOptions['rpc'],
  options: { expected?: string; now?: number } = {},
) =>
  reconcileUptoBuyer({
    journal,
    rpc,
    payer: PAYER,
    mint: MINT,
    treasury: TREASURY,
    expected: (digest) => (digest === DIGEST ? options.expected : undefined),
    now: () => options.now ?? NOW,
  });

void test('a claim that emptied the escrow settles, disputes or is unchecked against the buyer count', async () => {
  for (const [expected, outcome] of [
    ['9', RECONCILE_OUTCOMES.SETTLED],
    ['5', RECONCILE_OUTCOMES.DISPUTED],
    [undefined, RECONCILE_OUTCOMES.UNCHECKED],
  ] as const)
    await withJournal(async (journal) => {
      const { rpc, commitments } = chain([OPEN_TX, CLAIM_TX]);
      assert.deepEqual(await reconcile(journal, rpc, { expected }), [
        {
          requestDigest: DIGEST,
          channelId: CHANNEL,
          expectedAtomic: expected ?? null,
          outcome,
          chargedAtomic: '9',
          sellerAtomic: '9',
          feeAtomic: '0',
          refundedAtomic: '991',
          transaction: CLAIM_TX,
        },
      ]);
      // Resolved either way: it no longer blocks payments.
      const entry = await journal.get(DIGEST);
      assert.equal(entry?.state, PAYMENT_CHANNEL_STATES.SETTLED);
      assert.equal(entry?.chargedAtomic, '9');
      // Every read is finalized.
      assert.deepEqual([...new Set(commitments)], ['finalized']);
      // A second run finds nothing left to reconcile.
      assert.deepEqual(await reconcile(journal, rpc, { expected }), []);
    });
});

void test('an untouched address is open until the open can no longer land, then never opened', () =>
  withJournal(async (journal) => {
    const { rpc } = chain([]);
    const [open] = await reconcile(journal, rpc, {
      now: NOW + BUYER_RECONCILE.openLandMs,
    });
    assert.equal(open?.outcome, RECONCILE_OUTCOMES.OPEN);
    assert.equal(
      (await journal.get(DIGEST))?.state,
      PAYMENT_CHANNEL_STATES.OPEN,
    );
    const [never] = await reconcile(journal, rpc, {
      now: NOW + BUYER_RECONCILE.openLandMs + 1,
      expected: '0',
    });
    assert.equal(never?.outcome, RECONCILE_OUTCOMES.NEVER_OPENED);
    assert.equal(never?.chargedAtomic, '0');
    assert.equal((await journal.get(DIGEST))?.chargedAtomic, '0');
  }));

void test('a channel opened but not yet claimed stays open; a failing RPC changes nothing', () =>
  withJournal(async (journal) => {
    const [open] = await reconcile(journal, chain([OPEN_TX]).rpc, {
      expected: '9',
    });
    assert.equal(open?.outcome, RECONCILE_OUTCOMES.OPEN);
    assert.equal(open?.chargedAtomic, null);
    await assert.rejects(
      reconcile(journal, chain([OPEN_TX], true).rpc),
      (error) =>
        error instanceof UptoError &&
        error.code === UPTO_ERROR_CODES.UNAVAILABLE &&
        !error.message.includes('key'),
    );
    assert.equal(
      (await journal.get(DIGEST))?.state,
      PAYMENT_CHANNEL_STATES.OPEN,
    );
  }));
