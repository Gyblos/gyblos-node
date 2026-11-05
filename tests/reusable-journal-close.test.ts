// Reconciles a closed synthetic channel only after finalized refund and payout evidence.
import assert from 'node:assert/strict';
import test from 'node:test';

import { uptoTokenAccount } from 'x402-upto-metered';

import { CHANNEL_PROGRAM, DEVNET_TREASURY_OWNER } from '@gyblos/config';
import { openReusableJournal } from '@gyblos/payments-upto/reusable-journal';

import {
  A,
  context,
  fixture,
  observation,
  track,
} from './support/reusable-journal-fixture';

void test('closed channel is recoverable only when the actual refund is accounted for', () =>
  fixture(async (root) => {
    const { environment, payer, terms } = await context(root);
    let journal = await openReusableJournal({ environment });
    try {
      await track(journal, terms, payer);
      await journal.confirmOpen(terms.channelId, async () =>
        observation(terms),
      );
      await journal.issueVoucher(terms.channelId, A, '100', payer, async () =>
        observation(terms),
      );
      const proof = {
        finalized: true,
        network: terms.network,
        program: CHANNEL_PROGRAM,
        programTreasuryOwner: DEVNET_TREASURY_OWNER,
        escrowTokenAccount: await uptoTokenAccount(
          terms.channelId,
          terms.mint,
          terms.tokenProgram,
        ),
        channelId: terms.channelId,
        mint: terms.mint,
        buyer: terms.buyer,
        payTo: terms.payTo,
        treasury: terms.treasury,
        historyComplete: true,
        historyFromSlot: terms.openSlot,
        historyThroughSlot: '120',
        finalizedTipSlot: '120',
        channelClosed: true,
        escrowBalanceAtomic: '0',
        depositedAtomic: '1000',
        settledAtomic: '100',
        sellerReceivedAtomic: '97',
        treasuryReceivedAtomic: '2',
        programResidualAtomic: '1',
        buyerRefundAtomic: '900',
        buyerRefundOwner: terms.buyer,
        redirectedAtomic: '0',
        buyerRefundRedirectedAtomic: '0',
        sellerRedirectedAtomic: '0',
        treasuryRedirectedAtomic: '0',
      };
      for (const changed of [
        { historyComplete: false },
        { programTreasuryOwner: terms.buyer },
        { escrowTokenAccount: terms.buyer },
        { historyFromSlot: '2' },
        { historyThroughSlot: '119' },
        { channelClosed: false },
        { escrowBalanceAtomic: '1' },
        { buyerRefundAtomic: '0', redirectedAtomic: '900' },
        { buyerRefundOwner: terms.treasury },
        { buyerRefundAtomic: '899' },
        { sellerReceivedAtomic: '0', treasuryReceivedAtomic: '99' },
        {
          settledAtomic: '101',
          sellerReceivedAtomic: '98',
          buyerRefundAtomic: '899',
        },
      ]) {
        await assert.rejects(
          journal.recoverClosedChannel(
            terms.channelId,
            async () => ({ ...proof, ...changed }),
            payer,
            { programTreasuryOwner: DEVNET_TREASURY_OWNER },
          ),
        );
        assert.equal((await journal.get(terms.channelId))?.status, 'ready');
      }
      await journal.recoverClosedChannel(
        terms.channelId,
        async () => proof,
        payer,
        { programTreasuryOwner: DEVNET_TREASURY_OWNER },
      );
      await journal.close();
      journal = await openReusableJournal({ environment });
      const saved = await journal.get(terms.channelId);
      assert.equal(saved?.status, 'closed');
      assert.equal(saved?.closure?.buyerRefundAtomic, '900');
      await assert.rejects(
        journal.issueVoucher(terms.channelId, A, '101', payer, async () =>
          observation(terms),
        ),
      );
      await journal.beginOpening(
        { ...terms, channelId: terms.buyer, salt: '0' },
        payer,
      );
      assert.equal((await journal.get(terms.buyer))?.status, 'preparing');
    } finally {
      await journal.close();
    }
  }));

void test('a finalized redirected refund is recorded as a loss, never as refunded', () =>
  fixture(async (root) => {
    const { environment, payer, terms } = await context(root);
    const journal = await openReusableJournal({ environment });
    try {
      await track(journal, terms, payer);
      await journal.confirmOpen(terms.channelId, async () =>
        observation(terms),
      );
      const proof = {
        finalized: true,
        network: terms.network,
        program: CHANNEL_PROGRAM,
        programTreasuryOwner: DEVNET_TREASURY_OWNER,
        escrowTokenAccount: await uptoTokenAccount(
          terms.channelId,
          terms.mint,
          terms.tokenProgram,
        ),
        channelId: terms.channelId,
        mint: terms.mint,
        buyer: terms.buyer,
        payTo: terms.payTo,
        treasury: terms.treasury,
        historyComplete: true,
        historyFromSlot: terms.openSlot,
        historyThroughSlot: '120',
        finalizedTipSlot: '120',
        channelClosed: true,
        escrowBalanceAtomic: '0',
        depositedAtomic: '1000',
        settledAtomic: '0',
        sellerReceivedAtomic: '0',
        treasuryReceivedAtomic: '0',
        programResidualAtomic: '0',
        buyerRefundAtomic: '0',
        buyerRefundOwner: terms.buyer,
        redirectedAtomic: '1000',
        buyerRefundRedirectedAtomic: '1000',
        sellerRedirectedAtomic: '0',
        treasuryRedirectedAtomic: '0',
      };
      await journal.recoverClosedChannel(
        terms.channelId,
        async () => proof,
        payer,
        { programTreasuryOwner: DEVNET_TREASURY_OWNER },
      );
      const saved = await journal.get(terms.channelId);
      assert.equal(saved?.status, 'closed-redirected');
      assert.equal(saved?.closure?.buyerRefundAtomic, '0');
      assert.equal(saved?.closure?.buyerRefundRedirectedAtomic, '1000');
    } finally {
      await journal.close();
    }
  }));

void test('a closed channel still prevents the pending request from being signed on another channel', () =>
  fixture(async (root) => {
    const first = await context(root);
    const second = await context(root);
    const journal = await openReusableJournal({
      environment: first.environment,
    });
    try {
      await track(journal, first.terms, first.payer);
      await journal.confirmOpen(first.terms.channelId, async () =>
        observation(first.terms),
      );
      await track(journal, second.terms, second.payer);
      await journal.confirmOpen(second.terms.channelId, async () =>
        observation(second.terms),
      );
      let calls = 0;
      const failVoucher = {
        address: first.payer.address,
        signTransactions: first.payer.signTransactions.bind(first.payer),
        signMessages(...args: Parameters<typeof first.payer.signMessages>) {
          calls++;
          if (calls === 2) throw new Error('synthetic');
          return first.payer.signMessages(...args);
        },
      };
      await assert.rejects(
        journal.issueVoucher(
          first.terms.channelId,
          A,
          '100',
          failVoucher,
          async () => observation(first.terms),
        ),
      );
      const terms = first.terms;
      await journal.recoverClosedChannel(
        terms.channelId,
        async () => ({
          finalized: true,
          network: terms.network,
          program: CHANNEL_PROGRAM,
          programTreasuryOwner: DEVNET_TREASURY_OWNER,
          escrowTokenAccount: await uptoTokenAccount(
            terms.channelId,
            terms.mint,
            terms.tokenProgram,
          ),
          channelId: terms.channelId,
          mint: terms.mint,
          buyer: terms.buyer,
          payTo: terms.payTo,
          treasury: terms.treasury,
          historyComplete: true,
          historyFromSlot: terms.openSlot,
          historyThroughSlot: '120',
          finalizedTipSlot: '120',
          channelClosed: true,
          escrowBalanceAtomic: '0',
          depositedAtomic: '1000',
          settledAtomic: '0',
          sellerReceivedAtomic: '0',
          treasuryReceivedAtomic: '0',
          programResidualAtomic: '0',
          buyerRefundAtomic: '1000',
          buyerRefundOwner: terms.buyer,
          redirectedAtomic: '0',
          buyerRefundRedirectedAtomic: '0',
          sellerRedirectedAtomic: '0',
          treasuryRedirectedAtomic: '0',
        }),
        first.payer,
        { programTreasuryOwner: DEVNET_TREASURY_OWNER },
      );
      let newSignatures = 0;
      const counted = {
        address: second.payer.address,
        signTransactions: second.payer.signTransactions.bind(second.payer),
        signMessages(...args: Parameters<typeof second.payer.signMessages>) {
          newSignatures++;
          return second.payer.signMessages(...args);
        },
      };
      await assert.rejects(
        journal.issueVoucher(
          second.terms.channelId,
          A,
          '1',
          counted,
          async () => observation(second.terms),
        ),
      );
      assert.equal(newSignatures, 0);
    } finally {
      await journal.close();
    }
  }));
