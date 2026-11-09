// Recovery observes the original transaction through finalized, context-bound state before progress.
// Synthetic chain clocks/statuses and private temporary journals; no transaction reaches a network.
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

import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import { withdrawalFixture } from './support/buyer-withdrawal-recovery';
import { OPENING_DIGEST } from './support/opening';
import { signatureOf } from './support/upto-chain-history';

async function pending(
  run: (value: Awaited<ReturnType<typeof withdrawalFixture>>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'gyb-control-proof-'));
  const value = await withdrawalFixture(root);
  const entry = await value.journal.get(OPENING_DIGEST);
  assert.ok(entry?.channelId);
  await value.journal.recordWithdrawal!(
    OPENING_DIGEST,
    entry.channelId,
    undefined,
    value.attempt(signatureOf(1)),
  );
  try {
    await run(value);
  } finally {
    await value.journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

void test('a newer finalized account context becomes the durable recovery watermark', () =>
  pending(async (value) => {
    value.state.outcome = null;
    value.state.height = 901n;
    const actualSlot = value.state.slot + 100n;
    await value.update({
      status: UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
      closureStartedAt: value.state.blockTime,
    });
    const read = value.rpc.getAccountInfo;
    value.rpc.getAccountInfo = (...args) => ({
      async send(options) {
        return {
          ...(await read(...args).send(options)),
          context: { slot: actualSlot },
        };
      },
    });
    await value.run(await value.context());
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.checkedSlot,
      String(actualSlot),
    );
    value.rpc.getAccountInfo = read;
    value.state.slot++;
    await value.update({ status: UPTO_CHANNEL_ACCOUNT.statuses.OPEN });
    await assert.rejects(value.run(await value.context()), {
      code: UPTO_ERROR_CODES.UNAVAILABLE,
    });
    assert.equal(value.signatures(), 0);
    assert.equal(value.sent.length, 0);
  }));

void test('malformed finalized status cannot retire the original pending transaction', async () => {
  for (const status of [
    { err: false, confirmationStatus: UPTO_FINAL_COMMITMENT, slot: 400000000n },
    { err: null, confirmationStatus: UPTO_FINAL_COMMITMENT, slot: -1n },
  ])
    await pending(async (value) => {
      await value.update({
        status: UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
        closureStartedAt: value.state.blockTime,
      });
      value.state.outcome = status;
      await assert.rejects(value.run(await value.context()), {
        code: UPTO_ERROR_CODES.UNAVAILABLE,
      });
      assert.equal(
        (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
        true,
      );
      assert.equal(value.sent.length, 0);
    });
});

void test('unknown and nonfinal original status never ask for another signer or send', () =>
  pending(async (value) => {
    for (const status of [
      null,
      { err: null, confirmationStatus: null },
      { err: null, confirmationStatus: 'processed' },
      { err: null, confirmationStatus: 'confirmed' },
    ] satisfies (typeof value.state.outcome)[]) {
      value.state.outcome = status;
      const done = await value.run(await value.context());
      assert.equal(done.transaction, signatureOf(1));
      assert.equal(done.confirmed, false);
      assert.equal(
        (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
        true,
      );
    }
    assert.equal(value.signatures(), 0);
    assert.equal(value.sent.length, 0);
    assert.ok(
      value.lookups.every(
        (lookup) => lookup.search && lookup.signatures[0] === signatureOf(1),
      ),
    );
  }));

void test('finalized close resolves only the exact original attempt without settling the payment', () =>
  pending(async (value) => {
    const original = await value.journal.get(OPENING_DIGEST);
    await value.update({
      status: UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
      closureStartedAt: value.state.blockTime,
    });
    value.state.outcome = {
      err: null,
      confirmationStatus: UPTO_FINAL_COMMITMENT,
      slot: value.state.slot,
    };
    const done = await value.run(await value.context());
    assert.equal(done.transaction, signatureOf(1));
    assert.equal(done.confirmed, true);
    const entry = await value.journal.get(OPENING_DIGEST);
    assert.equal(entry?.withdrawal?.pending, false);
    assert.equal(entry?.updatedAt, original?.updatedAt);
    assert.equal(entry?.state, PAYMENT_CHANNEL_STATES.OPEN);
    assert.equal(entry?.chargedAtomic, null);
    assert.equal(value.signatures(), 0);
    assert.equal(value.sent.length, 0);
    // A contradictory stale OPEN view cannot become a new close.
    await value.update({ status: UPTO_CHANNEL_ACCOUNT.statuses.OPEN });
    await assert.rejects(value.run(await value.context()), {
      code: UPTO_ERROR_CODES.UNAVAILABLE,
    });
    assert.equal(value.signatures(), 0);
  }));

void test('a finalized failed transaction retires its exact attempt but does not retry within the call', () =>
  pending(async (value) => {
    value.state.outcome = {
      err: { InstructionError: [0, 'Custom'] },
      confirmationStatus: UPTO_FINAL_COMMITMENT,
      slot: value.state.slot,
    };
    await assert.rejects(value.run(await value.context()), {
      code: UPTO_ERROR_CODES.CHAIN_REJECTED,
    });
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      false,
    );
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.state,
      PAYMENT_CHANNEL_STATES.OPEN,
    );
    assert.equal(value.signatures(), 0);
    assert.equal(value.sent.length, 0);
  }));

void test('strict finalized lifetime expiry retires only after the original channel is safely observed', () =>
  pending(async (value) => {
    value.state.outcome = null;
    value.state.height = 900n;
    await value.run(await value.context());
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      true,
    );
    value.state.height = 901n;
    const done = await value.run(await value.context());
    assert.equal(
      done.confirmed,
      false,
      'expiry never fabricates a successful operation or refund',
    );
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      false,
    );
    assert.equal(value.signatures(), 0);
    assert.equal(value.sent.length, 0);
  }));

void test('expired absence and nonfinal inclusion remain uncertain, never proof of refund', () =>
  pending(async (value) => {
    value.state.height = 901n;
    value.state.outcome = null;
    value.state.accounts.clear();
    const done = await value.run(await value.context());
    assert.equal(done.confirmed, false);
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      true,
    );
    value.state.outcome = {
      err: null,
      confirmationStatus: 'confirmed',
      slot: value.state.slot,
    };
    await value.run(await value.context());
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      true,
    );
    assert.equal(value.signatures(), 0);
  }));

void test('stale contexts, foreign channel state and RPC failures preserve the original attempt', () =>
  pending(async (value) => {
    value.state.outcome = {
      err: null,
      confirmationStatus: UPTO_FINAL_COMMITMENT,
      slot: value.state.slot,
    };
    await value.update({
      status: UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
      closureStartedAt: value.state.blockTime,
    });
    const original = value.rpc.getAccountInfo;
    value.rpc.getAccountInfo = (...args) => ({
      async send(options) {
        const found = await original(...args).send(options);
        return { ...found, context: { slot: value.state.slot - 1n } };
      },
    });
    await assert.rejects(value.run(await value.context()), {
      code: UPTO_ERROR_CODES.UNAVAILABLE,
    });
    value.rpc.getAccountInfo = original;
    await value.update({ deposit: 999n });
    await assert.rejects(value.run(await value.context()), {
      code: UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH,
    });
    value.rpc.getSignatureStatuses = () => ({
      send: async () => {
        throw new Error('Synthetic private RPC failure');
      },
    });
    await assert.rejects(value.run(await value.context()), {
      code: UPTO_ERROR_CODES.UNAVAILABLE,
    });
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      true,
    );
    assert.equal(value.signatures(), 0);
    assert.equal(value.sent.length, 0);
  }));

void test('a failed or stale clear cannot erase a different concurrent transaction', () =>
  pending(async (value) => {
    await value.update({
      status: UPTO_CHANNEL_ACCOUNT.statuses.CLOSING,
      closureStartedAt: value.state.blockTime,
    });
    value.state.outcome = {
      err: null,
      confirmationStatus: UPTO_FINAL_COMMITMENT,
      slot: value.state.slot,
    };
    const context = await value.context();
    context.save = async () => {
      throw new Error('Synthetic checkpoint unavailable');
    };
    await assert.rejects(value.run(context), {
      code: UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE,
    });
    assert.equal(
      (await value.journal.get(OPENING_DIGEST))?.withdrawal?.pending,
      true,
    );
    assert.equal(value.sent.length, 0);
  }));
