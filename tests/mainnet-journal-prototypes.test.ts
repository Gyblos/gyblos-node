// A journal implementation may return objects with inherited getters; recovery must not lose them.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET } from '@gyblos/config';
import {
  reconcileUptoBuyer,
  withdrawUptoBuyer,
  type UptoJournalEntry,
  type UptoJournalPolicy,
} from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import { ADDRESS, entry, NOW, withJournal } from './support/mainnet-journal';
import { chainDouble } from './support/upto-chain-history';

class PolicyView implements UptoJournalPolicy {
  constructor(private readonly source: UptoJournalPolicy) {}
  get network() {
    return this.source.network;
  }
  get mint() {
    return this.source.mint;
  }
  get treasury() {
    return this.source.treasury;
  }
  get protocolFeeBps() {
    return this.source.protocolFeeBps;
  }
}
class EntryView implements UptoJournalEntry {
  constructor(private readonly source: UptoJournalEntry) {}
  get requestDigest() {
    return this.source.requestDigest;
  }
  get channelId() {
    return this.source.channelId;
  }
  get payTo() {
    return this.source.payTo;
  }
  get feePayer() {
    return this.source.feePayer;
  }
  get maxAtomic() {
    return this.source.maxAtomic;
  }
  get policy() {
    return this.source.policy ? new PolicyView(this.source.policy) : null;
  }
  get openSlot() {
    return this.source.openSlot;
  }
  get lastValidBlockHeight() {
    return this.source.lastValidBlockHeight;
  }
  get expiresAt() {
    return this.source.expiresAt;
  }
  get state() {
    return this.source.state;
  }
  get chargedAtomic() {
    return this.source.chargedAtomic;
  }
  get updatedAt() {
    return this.source.updatedAt;
  }
}

void test('reconciliation and withdrawal retain journal entries with inherited getters', async () => {
  for (const operation of ['reconcile', 'withdraw'] as const) {
    await withJournal(async (journal) => {
      await journal.put(entry(DEVNET));
      const held = (await journal.list())[0];
      assert.ok(held);
      const view = { ...journal, list: async () => [new EntryView(held)] };
      if (operation === 'reconcile') {
        const chain = chainDouble({
          mint: ADDRESS,
          history: new Map(),
          blockHeight: 2n,
          oldestSlot: 0n,
          accounts: new Set(),
        });
        const results = await reconcileUptoBuyer({
          journal: view,
          network: DEVNET,
          rpc: chain.rpc,
          payer: ADDRESS,
          mint: ADDRESS,
          treasury: ADDRESS,
          expected: () => undefined,
          report: async () => {},
        });
        assert.equal(results[0]?.outcome, 'never-opened');
        assert.equal(
          (await journal.list())[0]?.state,
          PAYMENT_CHANNEL_STATES.SETTLED,
        );
      } else {
        let calls = 0;
        const results = await withdrawUptoBuyer({
          journal: view,
          network: DEVNET,
          withdrawal: {
            withdraw: async () => {
              calls++;
              return {
                step: 'nothing',
                transaction: null,
                confirmed: true,
                retryAfterSeconds: null,
              };
            },
          },
          mint: ADDRESS,
          treasury: ADDRESS,
          protocolFeeBps: 300,
          maxTimeoutSeconds: 120,
          now: () => NOW + 500_000,
          report: async () => {},
        });
        assert.equal(results[0]?.step, 'nothing');
        assert.equal(calls, 1);
      }
    });
  }
});
