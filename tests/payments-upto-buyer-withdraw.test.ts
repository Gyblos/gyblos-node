// The buyer's withdrawal over its journal: a channel the seller can still claim (with a margin) is left
// alone until it cannot; every other open, signed channel takes one step with the distribution rebuilt
// from the buyer's policy; one channel's failure is reported and the run goes on; the journal stays.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  UPTO_ERROR_CODES,
  UPTO_WITHDRAW_STEPS,
  UptoError,
  type UptoWithdrawQuery,
} from 'x402-upto-metered';

import { buyerJournalPathsIn } from '@gyblos/config';
import {
  BUYER_WITHDRAW,
  openUptoBuyerJournal,
  WITHDRAW_STEPS,
  withdrawUptoBuyer,
  type UptoBuyerWithdrawResult,
} from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

const MINT = 'Mint111111111111111111111111111111111111111';
const PAY_TO = 'PayTo11111111111111111111111111111111111111';
const FEE_PAYER = 'FeePa11111111111111111111111111111111111111';
const TREASURY = 'Treas11111111111111111111111111111111111111';
const FIRST = 'Chan111111111111111111111111111111111111111';
const SECOND = 'Chan311111111111111111111111111111111111111';
const MAX_TIMEOUT_SECONDS = 120;
// When the seller can no longer claim an open signed at SIGNED_AT whose quote expired before that.
const SIGNED_AT = 1_000_000;
const CLAIMABLE_UNTIL =
  SIGNED_AT + MAX_TIMEOUT_SECONDS * 1_000 + BUYER_WITHDRAW.claimMarginMs;

const entry = (
  requestDigest: string,
  channelId: string | null,
  state: (typeof PAYMENT_CHANNEL_STATES)[keyof typeof PAYMENT_CHANNEL_STATES],
  expiresAt = SIGNED_AT + 60_000,
) => ({
  requestDigest,
  channelId,
  payTo: PAY_TO,
  feePayer: FEE_PAYER,
  maxAtomic: '1000',
  openSlot: '5',
  lastValidBlockHeight: '150',
  expiresAt,
  state,
  chargedAtomic: state === PAYMENT_CHANNEL_STATES.SETTLED ? '9' : null,
});

async function run(
  now: number,
  options: { expiresAt?: number; failFirst?: boolean } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-withdraw-'));
  const paths = buyerJournalPathsIn({ GYBLOS_HOME: home });
  try {
    const writer = await openUptoBuyerJournal({ paths, now: () => SIGNED_AT });
    for (const written of [
      entry(
        'aa'.repeat(32),
        FIRST,
        PAYMENT_CHANNEL_STATES.OPEN,
        options.expiresAt,
      ),
      entry(
        'bb'.repeat(32),
        'Chan211111111111111111111111111111111111111',
        PAYMENT_CHANNEL_STATES.SETTLED,
      ),
      entry('cc'.repeat(32), null, PAYMENT_CHANNEL_STATES.OPEN),
      entry('dd'.repeat(32), SECOND, PAYMENT_CHANNEL_STATES.OPEN),
    ])
      await writer.put(written);
    await writer.close();
    const journal = await openUptoBuyerJournal({ paths, now: () => now });
    try {
      const before = await journal.list();
      const asked: UptoWithdrawQuery[] = [];
      const reported: UptoBuyerWithdrawResult[] = [];
      const results = await withdrawUptoBuyer({
        journal,
        withdrawal: {
          withdraw: async (query) => {
            asked.push(query);
            if (options.failFirst && query.channelId === FIRST)
              throw new UptoError(UPTO_ERROR_CODES.CHAIN_REJECTED);
            return {
              step: UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED,
              transaction: 'sig',
              confirmed: true,
              retryAfterSeconds: 65,
            };
          },
        },
        mint: MINT,
        treasury: TREASURY,
        protocolFeeBps: 300,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        now: () => now,
        report: async (result) => {
          reported.push(result);
        },
      });
      assert.deepEqual(
        await journal.list(),
        before,
        'the journal is unchanged',
      );
      return { results, asked, reported };
    } finally {
      await journal.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

void test('a channel the seller can still claim, margin included, is left alone with when to come back', async () => {
  const { results, asked, reported } = await run(CLAIMABLE_UNTIL);
  assert.deepEqual(asked, []);
  assert.deepEqual(
    results.map(({ channelId, step, retryAfterSeconds, failure }) => [
      channelId,
      step,
      retryAfterSeconds,
      failure,
    ]),
    [
      [FIRST, WITHDRAW_STEPS.CLAIMABLE, 1, null],
      [SECOND, WITHDRAW_STEPS.CLAIMABLE, 1, null],
    ],
  );
  assert.deepEqual(reported, results);
});

void test('past the claim window, each open signed channel takes a step with the buyer’s own split', async () => {
  const { results, asked } = await run(CLAIMABLE_UNTIL + 1);
  const splits = paymentSplits({
    payTo: PAY_TO,
    treasury: TREASURY,
    protocolFeeBps: 300,
  });
  assert.deepEqual(
    asked,
    [FIRST, SECOND].map((channelId) => ({
      channelId,
      mint: MINT,
      rentPayer: FEE_PAYER,
      maxAtomic: '1000',
      splits,
    })),
  );
  assert.deepEqual(
    results.map(({ step, transaction }) => [step, transaction]),
    [
      [WITHDRAW_STEPS.CLOSE_REQUESTED, 'sig'],
      [WITHDRAW_STEPS.CLOSE_REQUESTED, 'sig'],
    ],
  );
});

void test('one channel failing is reported with its code and the next still takes its step', async () => {
  const { results, reported } = await run(CLAIMABLE_UNTIL + 1, {
    failFirst: true,
  });
  assert.deepEqual(
    results.map(({ channelId, step, failure, retryAfterSeconds }) => [
      channelId,
      step,
      failure,
      retryAfterSeconds,
    ]),
    [
      [
        FIRST,
        WITHDRAW_STEPS.FAILED,
        UPTO_ERROR_CODES.CHAIN_REJECTED,
        BUYER_WITHDRAW.failedRetrySeconds,
      ],
      [SECOND, WITHDRAW_STEPS.CLOSE_REQUESTED, null, 65],
    ],
  );
  assert.deepEqual(reported, results);
});

void test('a quote that outlives the payload keeps the channel claimable until it expires', async () => {
  const expiresAt = CLAIMABLE_UNTIL + 60_000;
  const early = await run(CLAIMABLE_UNTIL + 1, { expiresAt });
  assert.equal(early.results[0]?.step, WITHDRAW_STEPS.CLAIMABLE);
  const late = await run(expiresAt + BUYER_WITHDRAW.claimMarginMs + 1, {
    expiresAt,
  });
  assert.equal(late.results[0]?.step, WITHDRAW_STEPS.CLOSE_REQUESTED);
});
