// Synthetic journals and chain doubles verify that recovery never crosses networks.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';

import { buyerJournalPathsIn, DEVNET } from '@gyblos/config';
import {
  openUptoBuyerJournal,
  reconcileUptoBuyer,
  withdrawUptoBuyer,
} from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import {
  ADDRESS,
  DIGEST,
  entry,
  NOW,
  withJournal,
} from './support/mainnet-journal';
import { chainDouble } from './support/upto-chain-history';

void test('journal records network with the policy and persists it after restart', async () => {
  await withJournal(async (journal, root) => {
    await journal.put(entry(DEVNET));
    await journal.close();
    const reopened = await openUptoBuyerJournal({
      paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
      now: () => NOW,
    });
    try {
      assert.equal((await reopened.list())[0]?.policy?.network, DEVNET);
      const raw = JSON.parse(
        await readFile(
          buyerJournalPathsIn({ GYBLOS_HOME: root }).state,
          'utf8',
        ),
      );
      assert.equal(raw.version, 4);
    } finally {
      await reopened.close();
    }
  });
});

void test('reconcile keeps foreign or unbound networks open without RPC', async () => {
  for (const network of [SOLANA_MAINNET_CAIP2, null]) {
    await withJournal(async (journal) => {
      await journal.put(entry(network));
      const chain = chainDouble({
        mint: ADDRESS,
        history: new Map(),
        blockHeight: 2n,
        oldestSlot: 0n,
        accounts: new Set(),
      });
      let reports = 0;
      const options = {
        journal,
        network: DEVNET,
        rpc: chain.rpc,
        payer: ADDRESS,
        mint: ADDRESS,
        treasury: ADDRESS,
        expected: () => undefined,
        report: async () => {
          reports++;
        },
      };
      const [result] = await reconcileUptoBuyer(options);
      assert.equal(result?.outcome, 'open');
      assert.equal(
        result?.networkBlock,
        network === null ? 'unknown' : 'mismatch',
      );
      assert.deepEqual(chain.reads, []);
      assert.equal(reports, 1);
      assert.equal(
        (await journal.list())[0]?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
      );
    });
  }
});

void test('withdraw refuses foreign or unbound networks without transactions', async () => {
  for (const network of [SOLANA_MAINNET_CAIP2, null]) {
    await withJournal(async (journal) => {
      await journal.put(entry(network));
      let transactions = 0;
      let reports = 0;
      const options = {
        journal,
        network: DEVNET,
        withdrawal: {
          withdraw: async () => {
            transactions++;
            throw new Error('unexpected');
          },
        },
        mint: ADDRESS,
        treasury: ADDRESS,
        protocolFeeBps: 300,
        maxTimeoutSeconds: 120,
        now: () => NOW,
        report: async () => {
          reports++;
        },
      };
      const [result] = await withdrawUptoBuyer(options);
      assert.equal(result?.step, 'refused');
      assert.equal(
        result?.networkBlock,
        network === null ? 'unknown' : 'mismatch',
      );
      assert.equal(transactions, 0);
      assert.equal(reports, 1);
      assert.equal(
        (await journal.list())[0]?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
      );
    });
  }
});

void test('a signed journal entry cannot change its network or lose its channel', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(DEVNET));
    await assert.rejects(journal.put(entry(SOLANA_MAINNET_CAIP2)));
    await assert.rejects(journal.put({ ...entry(DEVNET), policy: null }));
    await assert.rejects(journal.put({ ...entry(DEVNET), channelId: null }));
    assert.equal((await journal.list())[0]?.policy?.network, DEVNET);
    assert.equal((await journal.list())[0]?.channelId, ADDRESS);
  });
});

void test('version 3 signed unresolved entries remain unchanged and prevent upgrade', async () => {
  await withJournal(async (journal, root) => {
    const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
    await journal.close();
    const { network: _network, ...legacyPolicy } = entry(DEVNET).policy;
    await writeFile(
      paths.state,
      JSON.stringify({
        version: 3,
        entries: [{ ...entry(DEVNET), policy: legacyPolicy, updatedAt: NOW }],
      }),
      { mode: 0o600 },
    );
    const reopened = await openUptoBuyerJournal({ paths, now: () => NOW });
    try {
      const before = await reopened.list();
      assert.equal(before[0]?.policy?.network, null);
      const rawBefore = await readFile(paths.state, 'utf8');
      await assert.rejects(
        reopened.put({
          ...entry(DEVNET),
          requestDigest: 'cd'.repeat(32),
          channelId: null,
        }),
      );
      assert.equal(await readFile(paths.state, 'utf8'), rawBefore);
    } finally {
      await reopened.close();
    }
  });
});

void test('mixed-network journal processes only matching channels and retains the rest', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(DEVNET));
    await journal.put({
      ...entry(SOLANA_MAINNET_CAIP2),
      requestDigest: 'cd'.repeat(32),
    });
    const chain = chainDouble({
      mint: ADDRESS,
      history: new Map(),
      blockHeight: 2n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    let reports = 0;
    const results = await reconcileUptoBuyer({
      journal,
      network: DEVNET,
      rpc: chain.rpc,
      payer: ADDRESS,
      mint: ADDRESS,
      treasury: ADDRESS,
      expected: () => undefined,
      report: async () => {
        reports++;
      },
    });
    assert.equal(results[0]?.outcome, 'never-opened');
    assert.equal(results[1]?.outcome, 'open');
    assert.equal(results[1]?.networkBlock, 'mismatch');
    assert.notEqual(chain.reads.length, 0);
    assert.equal(reports, 2);
    const held = await journal.list();
    assert.equal(held[0]?.state, PAYMENT_CHANNEL_STATES.SETTLED);
    assert.equal(held[1]?.state, PAYMENT_CHANNEL_STATES.OPEN);
  });
});

void test('journal rejects malformed network identifiers without changing the signed entry', async () => {
  await withJournal(async (journal) => {
    for (const network of ['', 'mainnet', 'solana:0', 'solana:bad:extra']) {
      await assert.rejects(journal.put(entry(network)));
      assert.deepEqual(await journal.list(), []);
    }
  });
});

void test('mutating the withdrawal port during reporting cannot redirect later channels', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(DEVNET));
    await journal.put({
      ...entry(DEVNET),
      requestDigest: 'cd'.repeat(32),
      channelId: 'SysvarRent111111111111111111111111111111111',
    });
    let expectedCalls = 0;
    let foreignCalls = 0;
    const done = () => ({
      step: 'nothing' as const,
      transaction: null,
      confirmed: true,
      retryAfterSeconds: null,
    });
    const options = {
      journal,
      network: DEVNET,
      withdrawal: {
        withdraw: async () => {
          expectedCalls++;
          return done();
        },
      },
      mint: ADDRESS,
      treasury: ADDRESS,
      protocolFeeBps: 300,
      maxTimeoutSeconds: 120,
      now: () => NOW + 500_000,
      report: async () => {
        options.withdrawal.withdraw = async () => {
          foreignCalls++;
          return done();
        };
      },
    };
    await withdrawUptoBuyer(options);
    assert.equal(expectedCalls, 2);
    assert.equal(foreignCalls, 0);
  });
});

void test('recovery fixes the RPC and journal methods before reporting another network', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(SOLANA_MAINNET_CAIP2));
    await journal.put({
      ...entry(DEVNET),
      requestDigest: 'cd'.repeat(32),
      channelId: 'SysvarRent111111111111111111111111111111111',
    });
    const chain = chainDouble({
      mint: ADDRESS,
      history: new Map(),
      blockHeight: 2n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    let foreignWrites = 0;
    const results = await reconcileUptoBuyer({
      journal,
      network: DEVNET,
      rpc: chain.rpc,
      payer: ADDRESS,
      mint: ADDRESS,
      treasury: ADDRESS,
      expected: () => undefined,
      report: async (result) => {
        if (result.networkBlock) {
          chain.rpc.getEpochInfo = () => ({
            send: async () => {
              throw new Error('wrong RPC');
            },
          });
          journal.put = async () => {
            foreignWrites++;
          };
        }
      },
    });
    assert.equal(results[0]?.networkBlock, 'mismatch');
    assert.equal(results[1]?.outcome, 'never-opened');
    assert.equal(foreignWrites, 0);
    const held = await journal.list();
    assert.equal(held[0]?.state, PAYMENT_CHANNEL_STATES.OPEN);
    assert.equal(held[1]?.state, PAYMENT_CHANNEL_STATES.SETTLED);
  });
});
