// A lost close acknowledgement never causes a second transaction to be sent.
// Signers, observations and files here are synthetic and temporary.
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import test from 'node:test';

import { openReusableJournal } from '@gyblos/payments-upto/reusable-journal';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';

import {
  A,
  context,
  fixture,
  observation,
  track,
} from './support/reusable-journal-fixture';

void test('a lost close acknowledgement survives restart and blocks another send', () =>
  fixture(async (root) => {
    const { environment, payer, terms, paths } = await context(root);
    let journal = await openReusableJournal({ environment });
    let sent = 0;
    let signed = 0;
    try {
      await track(journal, terms, payer);
      await journal.confirmOpen(terms.channelId, async () =>
        observation(terms),
      );
      const signer = {
        ...payer,
        async signTransactions(
          ...args: Parameters<typeof payer.signTransactions>
        ) {
          const record: unknown = JSON.parse(
            await readFile(paths.control, 'utf8'),
          );
          assert.ok(record && typeof record === 'object');
          assert.equal(Reflect.get(record, 'phase'), 'preparing');
          signed++;
          return payer.signTransactions(...args);
        },
      };
      const input = {
        channelId: terms.channelId,
        signer,
        lifetime: {
          blockhash: terms.recentBlockhash,
          lastValidBlockHeight: '100',
        },
        validateLifetime: async (
          network: string,
          lifetime: { blockhash: string; lastValidBlockHeight: string },
        ) => ({
          ...lifetime,
          network,
          finalized: true,
          valid: true,
          latestSlot: '0',
          validAtSlot: '0',
        }),
        read: async () => observation(terms),
        send: async (wire: string) => {
          const record: unknown = JSON.parse(
            await readFile(paths.control, 'utf8'),
          );
          assert.ok(record && typeof record === 'object');
          assert.equal(Reflect.get(record, 'phase'), 'pending');
          assert.equal(Reflect.get(record, 'wire'), wire);
          assert.equal((await lstat(paths.control)).mode & 0o777, 0o600);
          sent++;
          throw new Error('Synthetic lost reply');
        },
      };
      await assert.rejects(journal.submitRecoveryAction(input));
      assert.equal(sent, 1);
      assert.equal(signed, 1);
      await journal.close();
      journal = await openReusableJournal({ environment });
      await assert.rejects(journal.submitRecoveryAction(input));
      assert.equal(sent, 1);
      assert.equal(signed, 1);
      assert.equal((await journal.get(terms.channelId))?.status, 'ready');
    } finally {
      await journal.close();
    }
  }));

void test('a close signature lost before recording blocks another authorization', () =>
  fixture(async (root) => {
    const { environment, payer, terms, paths } = await context(root);
    let journal = await openReusableJournal({ environment });
    let sent = 0;
    let signed = 0;
    try {
      await track(journal, terms, payer);
      await journal.confirmOpen(terms.channelId, async () =>
        observation(terms),
      );
      const signer = {
        ...payer,
        async signTransactions(
          ...args: Parameters<typeof payer.signTransactions>
        ) {
          await payer.signTransactions(...args);
          signed++;
          throw new Error('Synthetic interruption after signing');
        },
      };
      const input = {
        channelId: terms.channelId,
        signer,
        lifetime: {
          blockhash: terms.recentBlockhash,
          lastValidBlockHeight: '100',
        },
        validateLifetime: async (
          network: string,
          lifetime: { blockhash: string; lastValidBlockHeight: string },
        ) => ({
          ...lifetime,
          network,
          finalized: true,
          valid: true,
          latestSlot: '0',
          validAtSlot: '0',
        }),
        read: async () => observation(terms),
        send: async () => {
          sent++;
          return '';
        },
      };
      await assert.rejects(journal.submitRecoveryAction(input), {
        code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
      });
      assert.equal(signed, 1);
      assert.equal(sent, 0);
      const record: unknown = JSON.parse(await readFile(paths.control, 'utf8'));
      assert.ok(record && typeof record === 'object');
      assert.equal(Reflect.get(record, 'phase'), 'preparing');
      await journal.close();
      journal = await openReusableJournal({ environment });
      await assert.rejects(journal.submitRecoveryAction(input));
      await assert.rejects(
        journal.issueVoucher(terms.channelId, A, '40', payer, async () =>
          observation(terms),
        ),
      );
      assert.equal(signed, 1);
      assert.equal(sent, 0);
    } finally {
      await journal.close();
    }
  }));

for (const phase of ['settled', 'paid']) {
  void test(`unknown ${phase} watermark cannot authorize a close`, () =>
    fixture(async (root) => {
      const { environment, payer, terms } = await context(root);
      const journal = await openReusableJournal({ environment });
      let sent = 0;
      try {
        await track(journal, terms, payer);
        await journal.confirmOpen(terms.channelId, async () =>
          observation(terms),
        );
        await journal.issueVoucher(terms.channelId, A, '40', payer, async () =>
          observation(terms),
        );
        const unknown =
          phase === 'settled'
            ? { settledAtomic: '30', paidAtomic: '0' }
            : { settledAtomic: '40', paidAtomic: '30' };
        const input = {
          channelId: terms.channelId,
          signer: payer,
          lifetime: {
            blockhash: terms.recentBlockhash,
            lastValidBlockHeight: '100',
          },
          validateLifetime: async (
            network: string,
            lifetime: { blockhash: string; lastValidBlockHeight: string },
          ) => ({
            ...lifetime,
            network,
            finalized: true,
            valid: true,
            latestSlot: '0',
            validAtSlot: '0',
          }),
          read: async () => ({ ...observation(terms), ...unknown }),
          send: async () => {
            sent++;
            return '';
          },
        };
        await assert.rejects(journal.submitRecoveryAction(input));
        assert.equal(sent, 0);
        assert.equal((await journal.get(terms.channelId))?.status, 'ready');
      } finally {
        await journal.close();
      }
    }));
}
