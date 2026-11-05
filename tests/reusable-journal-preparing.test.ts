// Recovery of interrupted preparations uses bounded finalized evidence, never a payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { openReusableJournal } from '@gyblos/payments-upto/reusable-journal';
import { reusableOpeningMemo } from '@gyblos/payments-upto/reusable-opening';

import {
  context,
  fixture,
  observation,
  syntheticOpeningMessage,
} from './support/reusable-journal-fixture';

void test('an uncertain preparation remains blocked even after an asserted absence', () =>
  fixture(async (root) => {
    const { environment, payer, terms } = await context(root);
    const provisional = { ...terms, channelId: terms.buyer, salt: '0' };
    let journal = await openReusableJournal({ environment });
    await journal.beginOpening(provisional, payer);
    const observation = {
      network: terms.network,
      buyer: terms.buyer,
      memo: await reusableOpeningMemo(provisional),
      finalized: true,
      programWindowVerified: true,
      historyComplete: true,
      noMatchingOpen: true,
      historyFromSlot: terms.openSlot,
      historyThroughSlot: '1602',
      finalizedTipSlot: '1602',
      finalizedBlockHeight: '101',
      blockHeightContextSlot: '1602',
      blockhash: terms.recentBlockhash,
      blockhashValid: false,
      blockhashContextSlot: '1601',
    };
    try {
      for (const changed of [
        { historyComplete: false },
        { programWindowVerified: false },
        { finalizedTipSlot: '1501' },
        { noMatchingOpen: false },
        { historyFromSlot: '2' },
        { historyThroughSlot: '1601' },
        { finalizedBlockHeight: '100' },
        { blockhashValid: true },
        { blockhashContextSlot: '1603' },
        { blockhash: terms.buyer },
        { memo: 'incorrect' },
      ]) {
        await assert.rejects(
          journal.recoverPreparation(
            terms.buyer,
            async () => ({ ...observation, ...changed }),
            payer,
          ),
        );
        assert.equal((await journal.get(terms.buyer))?.status, 'preparing');
      }
      await assert.rejects(
        journal.recoverPreparation(terms.buyer, async () => observation, payer),
      );
      await journal.close();
      journal = await openReusableJournal({ environment });
      await assert.rejects(journal.beginOpening(provisional, payer));
      assert.equal((await journal.get(terms.buyer))?.status, 'preparing');
      assert.equal((await journal.list()).length, 1);
    } finally {
      await journal.close();
    }
  }));

void test('a finalized matching opening is reconstructed and confirmed after restart', () =>
  fixture(async (root) => {
    const { environment, payer, terms } = await context(root);
    const provisional = { ...terms, channelId: terms.buyer, salt: '0' };
    let journal = await openReusableJournal({ environment });
    try {
      await journal.beginOpening(provisional, payer);
      const messageBytes = await syntheticOpeningMessage(terms, payer);
      const evidence = {
        network: terms.network,
        buyer: terms.buyer,
        finalized: true,
        transactionSucceeded: true,
        transactionSlot: '100',
        finalizedTipSlot: '100',
        messageBytes,
      };
      await assert.rejects(
        journal.recoverPreparedOpening(
          terms.buyer,
          async () => ({ ...evidence, transactionSucceeded: false }),
          payer,
        ),
      );
      const recovered = await journal.recoverPreparedOpening(
        terms.buyer,
        async () => evidence,
        payer,
      );
      assert.notEqual(recovered.channelId, payer.address);
      await journal.close();
      journal = await openReusableJournal({ environment });
      assert.equal((await journal.get(recovered.channelId))?.status, 'opening');
      await journal.confirmOpen(recovered.channelId, async () =>
        observation(recovered),
      );
      assert.equal((await journal.get(recovered.channelId))?.status, 'ready');
    } finally {
      await journal.close();
    }
  }));
