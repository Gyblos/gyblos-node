// Durable control attempts survive restart and block new purchases independently of settlement.
// SDK calls use synthetic chain replies and disposable private homes only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseUptoWithdrawalAttempt,
  UPTO_ERROR_CODES,
  UPTO_WITHDRAW_STEPS,
} from 'x402-upto-metered';

import {
  BUYER_JOURNAL,
  createUptoPaymentClient,
  hasUnresolvedBuyerPayments,
  openUptoBuyerJournal,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';

import { withdrawalFixture } from './support/buyer-withdrawal-recovery';
import { OPENING_DIGEST, OPENING_NOW } from './support/opening';
import { signatureOf } from './support/upto-chain-history';

async function isolated(
  run: (value: Awaited<ReturnType<typeof withdrawalFixture>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'gyb-control-recovery-'));
  const value = await withdrawalFixture(root);
  try {
    await run(value);
  } finally {
    await value.journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

void test('withdrawal metadata strictly rejects ambiguous, oversized and unknown fields', () => {
  const valid = {
    step: UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED,
    transaction: signatureOf(1),
    lastValidBlockHeight: '900',
    checkedSlot: '100',
    pending: true,
  };
  assert.deepEqual(parseUptoWithdrawalAttempt(valid), valid);
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, lastValidBlockHeight: '0900' },
    { ...valid, checkedSlot: '-1' },
    { ...valid, checkedSlot: '18446744073709551616' },
    { ...valid, transaction: 'invalid' },
    { ...valid, pending: 'true' },
    { ...valid, step: UPTO_WITHDRAW_STEPS.NOTHING },
  ])
    assert.throws(() => parseUptoWithdrawalAttempt(invalid), {
      code: UPTO_ERROR_CODES.INVALID_TERMS,
    });
});

void test('a control checkpoint is durable across reopen and preserves opening time and policy', () =>
  isolated(async (value) => {
    const original = await value.journal.get(OPENING_DIGEST);
    assert.ok(original?.channelId);
    const attempt = value.attempt(signatureOf(1));
    await value.journal.recordWithdrawal!(
      OPENING_DIGEST,
      original.channelId,
      undefined,
      attempt,
    );
    const saved = await value.journal.get(OPENING_DIGEST);
    assert.deepEqual(saved?.withdrawal, attempt);
    assert.equal(saved?.updatedAt, original.updatedAt);
    assert.deepEqual(saved?.policy, original.policy);
    await value.journal.close();
    const reopened = await openUptoBuyerJournal({
      paths: value.paths,
      now: () => OPENING_NOW + 100000,
    });
    try {
      assert.deepEqual(
        (await reopened.get(OPENING_DIGEST))?.withdrawal,
        attempt,
      );
      assert.equal(
        JSON.parse(await readFile(value.paths.state, 'utf8')).version,
        BUYER_JOURNAL.version,
      );
    } finally {
      await reopened.close();
    }
  }));

void test('a pending control record cannot be replaced or silently erased by normal journal APIs', () =>
  isolated(async (value) => {
    const original = await value.journal.get(OPENING_DIGEST);
    assert.ok(original?.channelId);
    const attempt = value.attempt(signatureOf(1));
    await value.journal.recordWithdrawal!(
      OPENING_DIGEST,
      original.channelId,
      undefined,
      attempt,
    );
    await assert.rejects(
      value.journal.recordWithdrawal!(
        OPENING_DIGEST,
        original.channelId,
        undefined,
        value.attempt(signatureOf(2)),
      ),
      { code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE },
    );
    await assert.rejects(value.journal.put(original), {
      code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
    });
    await assert.rejects(
      value.journal.remove(OPENING_DIGEST, original.channelId),
      { code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE },
    );
  }));

void test('pending control uncertainty blocks runtime and startup even when financial state is settled', () =>
  isolated(async (value) => {
    const original = await value.journal.get(OPENING_DIGEST);
    assert.ok(original?.channelId);
    await value.journal.recordWithdrawal!(
      OPENING_DIGEST,
      original.channelId,
      undefined,
      value.attempt(signatureOf(1)),
    );
    const pending = await value.journal.get(OPENING_DIGEST);
    assert.ok(pending);
    await value.journal.put({
      ...pending,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: '0',
    });
    assert.equal(
      (await value.client.reconcile())[0]?.state,
      PAYMENT_CHANNEL_STATES.OPEN,
    );
    await value.journal.close();
    assert.equal(await hasUnresolvedBuyerPayments(value.paths), true);
  }));

void test('a settled row with pending control survives retention pruning', () =>
  isolated(async (value) => {
    const original = await value.journal.get(OPENING_DIGEST);
    assert.ok(original?.channelId);
    await value.journal.recordWithdrawal!(
      OPENING_DIGEST,
      original.channelId,
      undefined,
      value.attempt(signatureOf(1)),
    );
    const pending = await value.journal.get(OPENING_DIGEST);
    assert.ok(pending);
    await value.journal.put({
      ...pending,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: '0',
    });
    value.now(OPENING_NOW + BUYER_JOURNAL.settledRetentionMs + 1);
    await value.journal.put({
      ...original,
      requestDigest: 'cd'.repeat(32),
      channelId: null,
    });
    assert.ok(await value.journal.get(OPENING_DIGEST));
  }));

void test('the exact signed control identity is on disk before the first broadcast', () =>
  isolated(async (value) => {
    let observed = false;
    const send = value.rpc.sendTransaction;
    value.rpc.sendTransaction = (...args) => ({
      async send(options) {
        const entry = await value.journal.get(OPENING_DIGEST);
        observed = !!entry?.withdrawal?.pending;
        return send(...args).send(options);
      },
    });
    const result = await value.run(await value.context());
    const entry = await value.journal.get(OPENING_DIGEST);
    assert.equal(observed, true);
    assert.equal(entry?.withdrawal?.transaction, result.transaction);
    assert.equal(entry?.withdrawal?.lastValidBlockHeight, '900');
    assert.equal(value.sent.length, 1);
  }));

void test('an unavailable durable checkpoint never broadcasts a signed control transaction', () =>
  isolated(async (value) => {
    await assert.rejects(
      value.run({
        save: async () => {
          throw new Error('Synthetic private store failure');
        },
      }),
      { code: UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE },
    );
    assert.equal(value.sent.length, 0);
  }));

void test('an existing live attempt is inspected without a fresh signer or broadcast', () =>
  isolated(async (value) => {
    const previous = value.attempt(signatureOf(1));
    const result = await value.run({
      previous,
      save: async () => {
        throw new Error('must not replace a live attempt');
      },
    });
    assert.equal(result.transaction, previous.transaction);
    assert.equal(result.confirmed, false);
    assert.equal(value.signatures(), 0);
    assert.equal(value.sent.length, 0);
  }));

void test('a v4 journal retains its accepted network and policy in the new reader', () =>
  isolated(async (value) => {
    const entry = await value.journal.get(OPENING_DIGEST);
    assert.ok(entry);
    await value.journal.close();
    await writeFile(
      value.paths.state,
      JSON.stringify({ version: 4, entries: [entry] }),
      { mode: 0o600 },
    );
    const journal = await openUptoBuyerJournal({
      paths: value.paths,
      now: () => OPENING_NOW,
    });
    try {
      assert.deepEqual(
        (await journal.get(OPENING_DIGEST))?.policy,
        entry.policy,
      );
      const client = createUptoPaymentClient({ ...value.options, journal });
      await assert.rejects(client.authorize(value.terms), {
        code: PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED,
      });
    } finally {
      await journal.close();
    }
  }));
