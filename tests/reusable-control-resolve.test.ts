// Resolves the exact retained close without signing or submitting again.
// Chain observations and signers here are synthetic and local.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from '@solana/kit';

import { openReusableJournal } from '@gyblos/payments-upto/reusable-journal';

import {
  context,
  fixture,
  observation,
  track,
} from './support/reusable-journal-fixture';

void test('a confirmed retained close resolves after restart without another send', () =>
  fixture(async (root) => {
    const { environment, payer, terms } = await context(root);
    let journal = await openReusableJournal({ environment });
    let wire = new Uint8Array();
    let sends = 0;
    try {
      await track(journal, terms, payer);
      await journal.confirmOpen(terms.channelId, async () =>
        observation(terms),
      );
      const signature = await journal.submitRecoveryAction({
        channelId: terms.channelId,
        signer: payer,
        lifetime: {
          blockhash: terms.recentBlockhash,
          lastValidBlockHeight: '100',
        },
        validateLifetime: async (network, lifetime) => ({
          ...lifetime,
          network,
          finalized: true,
          valid: true,
          latestSlot: '0',
          validAtSlot: '0',
        }),
        read: async () => observation(terms),
        send: async (encoded) => {
          sends++;
          wire = Uint8Array.from(getBase64Encoder().encode(encoded));
          return String(
            getSignatureFromTransaction(getTransactionDecoder().decode(wire)),
          );
        },
      });
      await journal.close();
      journal = await openReusableJournal({ environment });
      for (const changed of [
        { network: 'wrong-network' },
        { transaction: 'wrong-transaction' },
        { finalized: false },
        { signedTransaction: new Uint8Array([1]) },
      ]) {
        const rejected = await journal.resolveRecoveryAction({
          channelId: terms.channelId,
          signer: payer,
          read: async (transaction) => ({
            network: terms.network,
            transaction,
            finalized: true,
            succeeded: true,
            signedTransaction: wire,
            ...changed,
          }),
        });
        assert.equal(rejected, 'unknown');
      }
      let reads = 0;
      const status = await journal.resolveRecoveryAction({
        channelId: terms.channelId,
        signer: payer,
        read: async (transaction) => {
          reads++;
          assert.equal(transaction, signature);
          return {
            network: terms.network,
            transaction,
            finalized: true,
            succeeded: true,
            signedTransaction: wire,
          };
        },
      });
      assert.equal(status, 'confirmed');
      assert.equal(reads, 1);
      assert.equal(sends, 1);
      const contradictory = await journal.resolveRecoveryAction({
        channelId: terms.channelId,
        signer: payer,
        read: async (transaction) => ({
          network: terms.network,
          transaction,
          finalized: true,
          succeeded: false,
          signedTransaction: wire,
        }),
      });
      assert.equal(contradictory, 'unknown');
    } finally {
      await journal.close();
    }
  }));
