// The buyer's reconciliation from finalized history: a claim that emptied the escrow settles, disputes
// or is unchecked against the buyer's own count, reported before the journal changes; an open is never
// opened only on the chain's word; anything else stays open. Temporary journal; chain double.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  UPTO_ERROR_CODES,
  UPTO_HISTORY_LIMIT,
  UPTO_HISTORY_PAGES,
  UptoError,
} from 'x402-upto-metered';

import { buyerJournalPathsIn } from '@gyblos/config';
import {
  openUptoBuyerJournal,
  RECONCILE_OUTCOMES,
  reconcileUptoBuyer,
  type UptoBuyerJournal,
  type UptoReconcileResult,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';

import {
  chainDouble,
  signatureOf,
  type ChainState,
  type HistoryEntry,
} from './support/upto-chain-history';

const MINT = 'Mint111111111111111111111111111111111111111';
const CHANNEL = 'Chan111111111111111111111111111111111111111';
const OTHER = 'Chan211111111111111111111111111111111111111';
const PAYER = 'Payer11111111111111111111111111111111111111';
const PAY_TO = 'PayTo11111111111111111111111111111111111111';
const TREASURY = 'Treas11111111111111111111111111111111111111';
const PROGRAM = 'Progr11111111111111111111111111111111111111';
const DIGEST = 'ab'.repeat(32);
const OTHER_DIGEST = 'cd'.repeat(32);
// The open's slot and the last block height its blockhash allows, as journaled at signing.
const OPEN_SLOT = 50n;
const LAST_VALID = 100n;

const OPEN: HistoryEntry = {
  signature: signatureOf(0),
  flows: [
    { owner: PAYER, before: 1000n, after: 0n },
    { owner: CHANNEL, before: 0n, after: 1000n },
  ],
};
const CLAIM: HistoryEntry = {
  signature: signatureOf(1),
  flows: [
    { owner: CHANNEL, before: 1000n, after: 0n },
    { owner: PAY_TO, before: 0n, after: 9n },
    { owner: PAYER, before: 0n, after: 991n },
  ],
};

function state(history: HistoryEntry[], change: Partial<ChainState> = {}) {
  return {
    mint: MINT,
    history: new Map([[CHANNEL, history]]),
    blockHeight: LAST_VALID + 1n,
    oldestSlot: OPEN_SLOT,
    accounts: new Set<string>(),
    ...change,
  };
}

async function withJournal(
  run: (journal: UptoBuyerJournal) => Promise<void>,
  digests: [string, string][] = [[DIGEST, CHANNEL]],
) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-buyer-reconcile-'));
  const journal = await openUptoBuyerJournal({
    paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
    now: Date.now,
  });
  try {
    for (const [requestDigest, channelId] of digests)
      await journal.put({
        requestDigest,
        channelId,
        payTo: PAY_TO,
        feePayer: PAY_TO,
        maxAtomic: '1000',
        openSlot: String(OPEN_SLOT),
        lastValidBlockHeight: String(LAST_VALID),
        expiresAt: Date.now() + 60_000,
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
      });
    await run(journal);
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

function reconcile(
  journal: UptoBuyerJournal,
  chain: ChainState,
  options: {
    expected?: string;
    report?: (result: UptoReconcileResult) => Promise<void>;
  } = {},
) {
  const reported: UptoReconcileResult[] = [];
  const double = chainDouble(chain);
  const run = reconcileUptoBuyer({
    journal,
    rpc: double.rpc,
    payer: PAYER,
    mint: MINT,
    treasury: TREASURY,
    expected: (digest) => (digest === DIGEST ? options.expected : undefined),
    report:
      options.report ??
      (async (result) => {
        reported.push(result);
      }),
  });
  return { run, reported, commitments: double.commitments };
}

const outcomeOf = async (journal: UptoBuyerJournal, chain: ChainState) =>
  (await reconcile(journal, chain).run)[0]?.outcome;

void test('a claim that emptied the escrow settles, disputes or is unchecked, reported first', async () => {
  for (const [expected, outcome] of [
    ['9', RECONCILE_OUTCOMES.SETTLED],
    ['5', RECONCILE_OUTCOMES.DISPUTED],
    [undefined, RECONCILE_OUTCOMES.UNCHECKED],
  ] as const)
    await withJournal(async (journal) => {
      const { run, reported, commitments } = reconcile(
        journal,
        state([OPEN, CLAIM]),
        { expected },
      );
      const result = {
        requestDigest: DIGEST,
        channelId: CHANNEL,
        expectedAtomic: expected ?? null,
        outcome,
        chargedAtomic: '9',
        sellerAtomic: '9',
        feeAtomic: '0',
        refundedAtomic: '991',
        transaction: CLAIM.signature,
      };
      assert.deepEqual(await run, [result]);
      assert.deepEqual(reported, [result]);
      const entry = await journal.get(DIGEST);
      assert.equal(entry?.state, PAYMENT_CHANNEL_STATES.SETTLED);
      assert.equal(entry?.chargedAtomic, '9');
      assert.deepEqual([...new Set(commitments)], ['finalized']);
      // A second run finds nothing left to reconcile.
      assert.deepEqual(await reconcile(journal, state([])).run, []);
    });
});

void test('a report that fails leaves the channel open for the next run', () =>
  withJournal(async (journal) => {
    const { run } = reconcile(journal, state([OPEN, CLAIM]), {
      report: async () => {
        throw new Error('disk full');
      },
    });
    await assert.rejects(run, /disk full/);
    assert.equal(
      (await journal.get(DIGEST))?.state,
      PAYMENT_CHANNEL_STATES.OPEN,
    );
  }));

void test('a top-up or a redirected refund never makes the charge look smaller', () =>
  withJournal(async (journal) => {
    // 200 more was topped up: the charge is the outflow minus the refund, not the ceiling.
    const toppedUp: HistoryEntry = {
      signature: signatureOf(2),
      flows: [
        { owner: CHANNEL, before: 1200n, after: 0n },
        { owner: PAY_TO, before: 0n, after: 9n },
        { owner: PAYER, before: 0n, after: 1191n },
      ],
    };
    const [topUp] = await reconcile(journal, state([OPEN, toppedUp]), {
      expected: '9',
    }).run;
    assert.equal(topUp?.chargedAtomic, '9');
    assert.equal(topUp?.outcome, RECONCILE_OUTCOMES.SETTLED);
  }).then(() =>
    withJournal(async (journal) => {
      // The program sent the payer's refund to its own treasury: reported as charged, a dispute.
      const redirected: HistoryEntry = {
        signature: signatureOf(3),
        flows: [
          { owner: CHANNEL, before: 1000n, after: 0n },
          { owner: PAY_TO, before: 0n, after: 9n },
          { owner: PROGRAM, before: 0n, after: 991n },
        ],
      };
      const [result] = await reconcile(journal, state([OPEN, redirected]), {
        expected: '9',
      }).run;
      assert.equal(result?.chargedAtomic, '1000');
      assert.equal(result?.outcome, RECONCILE_OUTCOMES.DISPUTED);
    }),
  ));

void test('an open is never opened only when the whole chain agrees', () =>
  withJournal(async (journal) => {
    const spam = Array.from({ length: UPTO_HISTORY_LIMIT + 5 }, (_, index) => ({
      signature: signatureOf(100 + index),
      failed: true,
    }));
    // Each one keeps the channel open: an account at the address, a blockhash still valid, an RPC
    // that no longer holds the open's slot, a deposit, or history past the bound.
    for (const blocking of [
      state([], { accounts: new Set([CHANNEL]) }),
      state([], { blockHeight: LAST_VALID }),
      state([], { oldestSlot: OPEN_SLOT + 1n }),
      state([], { firstBlock: OPEN_SLOT + 1n }),
      state([OPEN]),
      state(
        Array.from(
          { length: UPTO_HISTORY_LIMIT * UPTO_HISTORY_PAGES },
          (_, index) => ({ signature: signatureOf(1000 + index) }),
        ),
      ),
    ])
      assert.equal(await outcomeOf(journal, blocking), RECONCILE_OUTCOMES.OPEN);
    assert.equal(
      (await journal.get(DIGEST))?.state,
      PAYMENT_CHANNEL_STATES.OPEN,
    );
    // Failed transactions moved nothing, however many there are.
    const double = chainDouble(state(spam));
    const [never] = await reconcileUptoBuyer({
      journal,
      rpc: double.rpc,
      payer: PAYER,
      mint: MINT,
      treasury: TREASURY,
      expected: () => '5',
      report: async () => {},
    });
    // The finalized tip comes first, and every later read is at least that recent: an open that landed
    // before the tip is already in the history read after it.
    assert.deepEqual(double.reads.slice(0, 2), [
      { call: 'tip' },
      { call: 'signatures', minContextSlot: double.tip },
    ]);
    assert.deepEqual(
      double.reads.filter((read) => read.call === 'account'),
      [{ call: 'account', minContextSlot: double.tip }],
    );
    assert.equal(never?.outcome, RECONCILE_OUTCOMES.NEVER_OPENED);
    // A version 1 open, whose blockhash lifetime is unknown, is never proven unopened.
    const legacy = await journal.get(DIGEST);
    await journal.put({
      ...legacy!,
      state: PAYMENT_CHANNEL_STATES.OPEN,
      chargedAtomic: null,
      openSlot: '0',
      lastValidBlockHeight: String(BigInt(PUBLIC_RECORD_LIMITS.maxAtomic)),
    });
    assert.equal(
      await outcomeOf(journal, state(spam, { oldestSlot: 0n })),
      RECONCILE_OUTCOMES.OPEN,
    );
    await journal.put({ ...legacy!, chargedAtomic: '0' });
    assert.equal(never?.chargedAtomic, '0');
    assert.equal((await journal.get(DIGEST))?.chargedAtomic, '0');
  }));

void test('entries are read in turn; a failing read keeps what was already reported', () =>
  withJournal(
    async (journal) => {
      // An unsigned entry and a settled one are not read.
      await journal.put({
        requestDigest: 'ef'.repeat(32),
        channelId: null,
        payTo: PAY_TO,
        feePayer: PAY_TO,
        maxAtomic: '1000',
        openSlot: '1',
        lastValidBlockHeight: '1',
        expiresAt: Date.now() + 60_000,
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
      });
      const chain = state([OPEN, CLAIM]);
      // The second channel's history is unreadable.
      const double = chainDouble(chain);
      const read = double.rpc.getSignaturesForAddress;
      double.rpc.getSignaturesForAddress = (account, config) =>
        String(account) === OTHER
          ? {
              send: async () => {
                throw new Error('rpc down');
              },
            }
          : read(account, config);
      const reported: string[] = [];
      await assert.rejects(
        reconcileUptoBuyer({
          journal,
          rpc: double.rpc,
          payer: PAYER,
          mint: MINT,
          treasury: TREASURY,
          expected: () => '9',
          report: async (result) => {
            reported.push(result.requestDigest);
          },
        }),
        (error) =>
          error instanceof UptoError &&
          error.code === UPTO_ERROR_CODES.UNAVAILABLE &&
          !error.message.includes('rpc'),
      );
      assert.deepEqual(reported, [DIGEST]);
      assert.equal(
        (await journal.get(DIGEST))?.state,
        PAYMENT_CHANNEL_STATES.SETTLED,
      );
      assert.equal(
        (await journal.get(OTHER_DIGEST))?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
      );
    },
    [
      [DIGEST, CHANNEL],
      [OTHER_DIGEST, OTHER],
    ],
  ));
