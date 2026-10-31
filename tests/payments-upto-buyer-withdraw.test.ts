// The buyer's withdrawal over its journal: a channel the seller can still claim is left alone until
// it cannot; every other open, signed channel takes one step with the distribution rebuilt from the
// buyer's policy; settled or unsigned entries are skipped and the journal is never changed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { UPTO_WITHDRAW_STEPS, type UptoWithdrawQuery } from 'x402-upto-metered';

import { buyerJournalPathsIn } from '@gyblos/config';
import {
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
const CLAIM_WINDOW_MS = 120_000;
const SIGNED_AT = 1_000_000;

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

async function run(now: number, expiresAt?: number) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-withdraw-'));
  const paths = buyerJournalPathsIn({ GYBLOS_HOME: home });
  try {
    const writer = await openUptoBuyerJournal({ paths, now: () => SIGNED_AT });
    await writer.put(
      entry(
        'aa'.repeat(32),
        'Chan111111111111111111111111111111111111111',
        PAYMENT_CHANNEL_STATES.OPEN,
        expiresAt,
      ),
    );
    await writer.put(
      entry(
        'bb'.repeat(32),
        'Chan211111111111111111111111111111111111111',
        PAYMENT_CHANNEL_STATES.SETTLED,
      ),
    );
    await writer.put(entry('cc'.repeat(32), null, PAYMENT_CHANNEL_STATES.OPEN));
    await writer.close();
    const journal = await openUptoBuyerJournal({ paths, now: () => now });
    const before = await journal.list();
    const asked: UptoWithdrawQuery[] = [];
    const reported: UptoBuyerWithdrawResult[] = [];
    const results = await withdrawUptoBuyer({
      journal,
      withdrawal: {
        withdraw: async (query) => {
          asked.push(query);
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
      claimWindowMs: CLAIM_WINDOW_MS,
      now: () => now,
      report: async (result) => {
        reported.push(result);
      },
    });
    assert.deepEqual(await journal.list(), before, 'the journal is unchanged');
    await journal.close();
    return { results, asked, reported };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

void test('a channel the seller can still claim is left alone, with when to come back', async () => {
  const { results, asked, reported } = await run(SIGNED_AT + CLAIM_WINDOW_MS);
  assert.deepEqual(asked, []);
  assert.deepEqual(results, [
    {
      requestDigest: 'aa'.repeat(32),
      channelId: 'Chan111111111111111111111111111111111111111',
      step: WITHDRAW_STEPS.CLAIMABLE,
      transaction: null,
      confirmed: true,
      retryAfterSeconds: 1,
    },
  ]);
  assert.deepEqual(reported, results);
});

void test('past the claim window, the open signed channel takes a step with the buyer’s own split', async () => {
  const { results, asked } = await run(SIGNED_AT + CLAIM_WINDOW_MS + 1);
  assert.deepEqual(asked, [
    {
      channelId: 'Chan111111111111111111111111111111111111111',
      mint: MINT,
      rentPayer: FEE_PAYER,
      maxAtomic: '1000',
      splits: paymentSplits({
        payTo: PAY_TO,
        treasury: TREASURY,
        protocolFeeBps: 300,
      }),
    },
  ]);
  assert.equal(results[0]?.step, WITHDRAW_STEPS.CLOSE_REQUESTED);
  assert.equal(results[0]?.transaction, 'sig');
});

void test('a quote that outlives the claim window keeps the channel claimable until it expires', async () => {
  const expiresAt = SIGNED_AT + CLAIM_WINDOW_MS * 2;
  const early = await run(SIGNED_AT + CLAIM_WINDOW_MS + 1, expiresAt);
  assert.deepEqual(early.asked, []);
  assert.equal(early.results[0]?.step, WITHDRAW_STEPS.CLAIMABLE);
  const late = await run(expiresAt + 1, expiresAt);
  assert.equal(late.asked.length, 1);
});
