// Buyer opening identity is durable before signing and never becomes a second open on recovery.
// Controlled signer/store faults and finalized-history doubles use only synthetic temporary homes.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createUptoAuthorization, decodeUptoPayload } from 'x402-upto-metered';

import {
  BUYER_JOURNAL,
  createUptoPaymentClient,
  hasUnresolvedBuyerPayments,
  openUptoBuyerJournal,
  RECONCILE_OUTCOMES,
  reconcileUptoBuyer,
  uptoTermsFor,
  type UptoBuyerJournal,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';

import { OPENING_DIGEST, OPENING_NOW, openingFixture } from './support/opening';
import { chainDouble } from './support/upto-chain-history';

async function isolated(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyb-opening-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
void test('the actual payer sees the exact channel and lifetime already durable before it signs', () =>
  isolated(async (root) => {
    const value = await openingFixture(root);
    let seen: string | null | undefined;
    value.sign(async (...args) => {
      const entry = await value.journal.get(OPENING_DIGEST);
      seen = entry?.channelId;
      assert.ok(seen, 'channel identity must be durable before signing');
      assert.equal(entry?.openSlot, value.hints.recentSlot);
      assert.equal(
        entry?.lastValidBlockHeight,
        value.hints.lastValidBlockHeight,
      );
      return value.payer.signTransactions(...args);
    });
    try {
      const auth = await value.client.authorize(value.terms);
      assert.equal(seen, auth.channelId);
      assert.equal(value.calls(), 1);
      assert.equal(
        (await value.journal.get(OPENING_DIGEST))?.openSlot,
        decodeUptoPayload(auth).openSlot,
      );
      assert.equal(
        JSON.parse(await readFile(value.paths.state, 'utf8')).version,
        BUYER_JOURNAL.version,
      );
    } finally {
      await value.journal.close();
    }
  }));
for (const signed of [false, true])
  void test(`a signer ${signed ? 'signing then losing its response' : 'refusing'} retains the original channel across restart`, () =>
    isolated(async (root) => {
      const value = await openingFixture(root);
      value.sign(async (...args) => {
        if (signed) await value.payer.signTransactions(...args);
        throw new Error('Synthetic wallet unavailable');
      });
      try {
        await assert.rejects(value.client.authorize(value.terms), {
          code: PAYMENT_ERROR_CODES.UNAVAILABLE,
        });
        const entry = await value.journal.get(OPENING_DIGEST);
        assert.ok(
          entry?.channelId,
          'uncertain opening must remain inspectable',
        );
        await value.journal.close();
        assert.equal(await hasUnresolvedBuyerPayments(value.paths), true);
        const journal = await openUptoBuyerJournal({
          paths: value.paths,
          now: () => OPENING_NOW,
        });
        try {
          const restarted = createUptoPaymentClient({
            ...value.options,
            journal,
            hints: async () => {
              throw new Error('must not build another open');
            },
          });
          await assert.rejects(restarted.authorize(value.terms), {
            code: PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED,
          });
          assert.deepEqual(await restarted.reconcile(), [
            {
              channelId: entry.channelId,
              requestDigest: OPENING_DIGEST,
              state: PAYMENT_CHANNEL_STATES.OPEN,
              chargedAtomic: null,
            },
          ]);
          assert.equal(value.calls(), 1);
        } finally {
          await journal.close();
        }
      } finally {
        await value.journal.close();
      }
    }));
void test('an uncertain checkpoint write starts no signer and preserves the channel if the write landed', () =>
  isolated(async (root) => {
    const value = await openingFixture(root);
    const journal: UptoBuyerJournal = {
      ...value.journal,
      async put(entry) {
        await value.journal.put(entry);
        if (entry.channelId)
          throw new Error('Synthetic directory sync failure');
      },
    };
    try {
      await assert.rejects(
        createUptoPaymentClient({ ...value.options, journal }).authorize(
          value.terms,
        ),
        { code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE },
      );
      assert.equal(value.calls(), 0);
      assert.ok((await value.journal.get(OPENING_DIGEST))?.channelId);
    } finally {
      await value.journal.close();
    }
  }));
void test('a checkpoint that cannot be stored never asks the payer to sign', () =>
  isolated(async (root) => {
    const value = await openingFixture(root);
    const journal: UptoBuyerJournal = {
      ...value.journal,
      async put(entry) {
        if (entry.channelId) throw new Error('Synthetic store down');
        await value.journal.put(entry);
      },
    };
    try {
      await assert.rejects(
        createUptoPaymentClient({ ...value.options, journal }).authorize(
          value.terms,
        ),
        { code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE },
      );
      assert.equal(value.calls(), 0);
    } finally {
      await value.journal.close();
    }
  }));
void test('prepared opening identity survives quote expiry and is resolved only by complete finalized evidence', () =>
  isolated(async (root) => {
    const value = await openingFixture(root);
    value.sign(async () => {
      throw new Error('Synthetic wallet unavailable');
    });
    try {
      await assert.rejects(value.client.authorize(value.terms), {
        code: PAYMENT_ERROR_CODES.UNAVAILABLE,
      });
      value.now(OPENING_NOW + 120000);
      const entry = await value.journal.get(OPENING_DIGEST);
      assert.ok(entry?.channelId);
      await value.journal.put({
        ...entry,
        requestDigest: 'cd'.repeat(32),
        channelId: null,
      });
      assert.equal(
        (await value.journal.get(OPENING_DIGEST))?.channelId,
        entry.channelId,
      );
      const state = {
        mint: value.terms.mint,
        history: new Map(),
        blockHeight: BigInt(value.hints.lastValidBlockHeight),
        oldestSlot: BigInt(value.hints.recentSlot),
        firstBlock: BigInt(value.hints.recentSlot),
        accounts: new Set<string>(),
      };
      const inspect = () =>
        reconcileUptoBuyer({
          journal: value.journal,
          network: value.terms.network,
          payer: value.payer.address,
          mint: value.terms.mint,
          treasury: value.terms.treasury,
          rpc: chainDouble(state).rpc,
          expected: () => undefined,
          report: async () => {},
        });
      assert.equal((await inspect())[0]?.outcome, RECONCILE_OUTCOMES.OPEN);
      assert.equal(
        (await value.journal.get(OPENING_DIGEST))?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
      );
      state.blockHeight++;
      assert.equal(
        (await inspect())[0]?.outcome,
        RECONCILE_OUTCOMES.NEVER_OPENED,
      );
      assert.equal(
        (await value.journal.get(OPENING_DIGEST))?.state,
        PAYMENT_CHANNEL_STATES.SETTLED,
      );
      assert.equal(value.calls(), 1);
    } finally {
      await value.journal.close();
    }
  }));
void test('the original opening slot, lifetime and accepted parties cannot be rewritten', () =>
  isolated(async (root) => {
    const value = await openingFixture(root);
    try {
      await value.client.authorize(value.terms);
      const entry = await value.journal.get(OPENING_DIGEST);
      assert.ok(entry);
      for (const change of [
        { openSlot: '1' },
        { lastValidBlockHeight: '1' },
        { expiresAt: entry.expiresAt - 1 },
        { payTo: value.payer.address },
        { policy: { ...entry.policy!, mint: value.payer.address } },
      ]) {
        await assert.rejects(value.journal.put({ ...entry, ...change }), {
          code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
        });
        assert.deepEqual(await value.journal.get(OPENING_DIGEST), entry);
      }
    } finally {
      await value.journal.close();
    }
  }));
void test('SDK preparation snapshots hints and exposes only an independent checkpoint copy', () =>
  isolated(async (root) => {
    const value = await openingFixture(root);
    let callbacks = 0;
    const original = { ...value.hints };
    try {
      const auth = await createUptoAuthorization(
        value.payer,
        await uptoTermsFor(value.terms, value.options.settings),
        value.hints,
        async (open) => {
          callbacks++;
          assert.equal(
            open.lastValidBlockHeight,
            original.lastValidBlockHeight,
          );
          value.hints.recentSlot = '1';
          value.hints.lastValidBlockHeight = '1';
          open.channelId = value.payer.address;
          open.openSlot = '1';
        },
      );
      assert.equal(callbacks, 1);
      assert.notEqual(auth.channelId, value.payer.address);
      assert.equal(decodeUptoPayload(auth).openSlot, original.recentSlot);
    } finally {
      await value.journal.close();
    }
  }));
