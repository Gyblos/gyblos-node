// Product withdrawal composition persists original identities through report loss and reopen.
// Synthetic genesis, finalized state and temporary homes; no network or inference is involved.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_ERROR_CODES,
  UPTO_FINAL_COMMITMENT,
} from 'x402-upto-metered';

import {
  createUptoPaymentClient,
  createUptoWithdrawal,
  openUptoBuyerJournal,
  withdrawUptoBuyer,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';

import { withdrawalFixture } from './support/buyer-withdrawal-recovery';
import { OPENING_DIGEST, OPENING_NOW } from './support/opening';
import { signatureOf } from './support/upto-chain-history';

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

async function isolated(
  run: (value: Awaited<ReturnType<typeof withdrawalFixture>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'gyb-control-integration-'));
  const value = await withdrawalFixture(root);
  try {
    await run(value);
  } finally {
    await value.journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

void test('an already-settled row can resolve its original pending control without a new send', () =>
  isolated(async (value) => {
    const context = await value.context();
    await context.save(value.attempt(signatureOf(1)));
    const entry = await value.journal.get(OPENING_DIGEST);
    assert.ok(entry);
    await value.journal.put({
      ...entry,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: '0',
    });
    await value.update({
      status: UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
      closureStartedAt: value.state.blockTime,
    });
    value.state.outcome = {
      err: null,
      confirmationStatus: UPTO_FINAL_COMMITMENT,
      slot: value.state.slot,
    };
    const [done] = await withdrawUptoBuyer({
      journal: value.journal,
      network: value.terms.network,
      withdrawal: createUptoWithdrawal(value.rpc, {
        payer: value.payer,
        network: value.terms.network,
        tokenProgram: value.options.settings.tokenProgram,
      }),
      mint: value.terms.mint,
      treasury: value.terms.treasury,
      protocolFeeBps: value.terms.protocolFeeBps,
      maxTimeoutSeconds: value.options.settings.maxTimeoutSeconds,
      now: () => OPENING_NOW,
      report: async () => {},
    });
    assert.equal(done?.transaction, signatureOf(1));
    assert.equal(done?.confirmed, true);
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      false,
    );
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.state,
      PAYMENT_CHANNEL_STATES.SETTLED,
    );
    assert.equal(value.sent.length, 0);
  }));

void test('a settled financial row rejects a new withdrawal prepared from an older open snapshot', () =>
  isolated(async (value) => {
    const context = await value.context();
    const entry = await value.journal.get(OPENING_DIGEST);
    assert.ok(entry);
    await value.journal.put({
      ...entry,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: '0',
    });
    await assert.rejects(value.run(context), {
      code: UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE,
    });
    assert.equal(value.sent.length, 0);
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal,
      undefined,
    );
  }));

void test('pending control introduced during opening preparation blocks the new payer signature', () =>
  isolated(async (value) => {
    const entered = barrier();
    const release = barrier();
    const client = createUptoPaymentClient({
      ...value.options,
      hints: async () => {
        entered.resolve();
        await release.promise;
        return value.hints;
      },
    });
    const before = value.calls();
    const signing = client.authorize({
      ...value.terms,
      requestDigest: 'cd'.repeat(32),
    });
    await entered.promise;
    const context = await value.context();
    await context.save(value.attempt(signatureOf(1)));
    release.resolve();
    await assert.rejects(signing, {
      code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
    });
    assert.equal(value.calls(), before);
  }));

void test('product withdrawal recovers a lost send/report reply from the same private journal', () =>
  isolated(async (value) => {
    const send = value.rpc.sendTransaction;
    value.rpc.sendTransaction = (...args) => ({
      async send(options) {
        await send(...args).send(options);
        throw new Error('Synthetic lost send reply');
      },
    });
    const withdrawal = createUptoWithdrawal(value.rpc, {
      payer: value.payer,
      network: value.terms.network,
      tokenProgram: value.options.settings.tokenProgram,
      sleep: async () => {},
    });
    const options = {
      journal: value.journal,
      network: value.terms.network,
      withdrawal,
      mint: value.terms.mint,
      treasury: value.terms.treasury,
      protocolFeeBps: value.terms.protocolFeeBps,
      maxTimeoutSeconds: value.options.settings.maxTimeoutSeconds,
      now: () => OPENING_NOW + 1_000_000,
      report: async () => {
        throw new Error('Synthetic lost report');
      },
    };
    await assert.rejects(withdrawUptoBuyer(options), /Synthetic lost report/);
    const saved = await value.journal.get(OPENING_DIGEST);
    assert.equal(saved?.withdrawal?.transaction, value.sent[0]?.signature);
    assert.equal(saved?.withdrawal?.pending, true);
    await value.journal.close();
    const reopened = await openUptoBuyerJournal({
      paths: value.paths,
      now: () => OPENING_NOW,
    });
    try {
      await value.update({
        status: UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
        closureStartedAt: value.state.blockTime,
      });
      value.state.outcome = {
        err: null,
        confirmationStatus: UPTO_FINAL_COMMITMENT,
        slot: value.state.slot,
      };
      // Pending recovery runs even if a clock change would otherwise make the original open claimable.
      const [done] = await withdrawUptoBuyer({
        ...options,
        journal: reopened,
        now: () => OPENING_NOW,
        report: async () => {},
      });
      assert.equal(done?.transaction, saved?.withdrawal?.transaction);
      assert.equal(done?.confirmed, true);
      assert.equal(value.sent.length, 1);
      assert.equal(
        (await reopened.get(OPENING_DIGEST))?.withdrawal?.pending,
        false,
      );
      assert.equal(
        (await reopened.get(OPENING_DIGEST))?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
      );
    } finally {
      await reopened.close();
    }
  }));

void test('concurrent withdrawal attempts cannot both cross the durable checkpoint', () =>
  isolated(async (value) => {
    const contexts = await Promise.all([value.context(), value.context()]);
    const results = await Promise.allSettled(contexts.map(value.run));
    assert.equal(
      results.filter((item) => item.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter((item) => item.status === 'rejected').length,
      1,
    );
    assert.equal(value.sent.length, 1);
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      true,
    );
  }));

void test('a checkpoint that lands then reports failure still prevents broadcast and replacement', () =>
  isolated(async (value) => {
    const context = await value.context();
    const save = context.save;
    context.save = async (next) => {
      await save(next);
      throw new Error('Synthetic sync outcome lost');
    };
    await assert.rejects(value.run(context), {
      code: UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE,
    });
    assert.equal(value.sent.length, 0);
    const done = await value.run(await value.context());
    assert.equal(done.confirmed, false);
    assert.equal(value.sent.length, 0);
  }));
