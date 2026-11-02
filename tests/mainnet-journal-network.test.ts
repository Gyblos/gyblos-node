// Synthetic journals and chain doubles verify that recovery never crosses networks.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';

import { buyerJournalPathsIn, DEVNET } from '@gyblos/config';
import {
  openUptoBuyerJournal,
  reconcileUptoBuyer,
  withdrawUptoBuyer,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import { chainDouble } from './support/upto-chain-history';

const ADDRESS = '11111111111111111111111111111111';
const DIGEST = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;
const REFUSAL = (error: unknown) =>
  error instanceof PaymentError &&
  error.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS;
const entry = (network: string | null) => ({
  requestDigest: DIGEST,
  channelId: ADDRESS,
  payTo: ADDRESS,
  feePayer: ADDRESS,
  maxAtomic: '1000',
  policy: { network, mint: ADDRESS, treasury: ADDRESS, protocolFeeBps: 300 },
  openSlot: '1',
  lastValidBlockHeight: '1',
  expiresAt: NOW - 500_000,
  state: PAYMENT_CHANNEL_STATES.OPEN,
  chargedAtomic: null,
});

async function withJournal(
  run: (
    journal: Awaited<ReturnType<typeof openUptoBuyerJournal>>,
    root: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-network-journal-'));
  const journal = await openUptoBuyerJournal({
    paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
    now: () => NOW,
  });
  try {
    await run(journal, root);
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

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

void test('reconcile refuses a foreign or unbound legacy network before RPC or reporting', async () => {
  for (const network of [DEVNET, null]) {
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
        network: SOLANA_MAINNET_CAIP2,
        rpc: chain.rpc,
        payer: ADDRESS,
        mint: ADDRESS,
        treasury: ADDRESS,
        expected: () => undefined,
        report: async () => {
          reports++;
        },
      };
      await assert.rejects(reconcileUptoBuyer(options), REFUSAL);
      assert.deepEqual(chain.reads, []);
      assert.equal(reports, 0);
      assert.equal(
        (await journal.list())[0]?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
      );
    });
  }
});

void test('withdraw refuses a foreign or unbound legacy network before transactions or reporting', async () => {
  for (const network of [DEVNET, null]) {
    await withJournal(async (journal) => {
      await journal.put(entry(network));
      let transactions = 0;
      let reports = 0;
      const options = {
        journal,
        network: SOLANA_MAINNET_CAIP2,
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
      await assert.rejects(withdrawUptoBuyer(options), REFUSAL);
      assert.equal(transactions, 0);
      assert.equal(reports, 0);
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

void test('version 3 signed entries keep their network unknown through a version 4 write', async () => {
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
      await reopened.put({
        ...entry(DEVNET),
        requestDigest: 'cd'.repeat(32),
        channelId: null,
      });
      const after = await reopened.list();
      assert.equal(after[0]?.policy?.network, null);
      const raw = JSON.parse(await readFile(paths.state, 'utf8'));
      assert.equal(raw.version, 4);
      assert.equal(raw.entries[0].policy.network, null);
    } finally {
      await reopened.close();
    }
  });
});

void test('mixed-network journal refuses before processing even its first matching entry', async () => {
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
    await assert.rejects(
      reconcileUptoBuyer({
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
      }),
      REFUSAL,
    );
    assert.deepEqual(chain.reads, []);
    assert.equal(reports, 0);
    assert.equal((await journal.list()).length, 2);
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

void test('a mainnet-bound synthetic journal can be reconciled against a matching fake chain', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(SOLANA_MAINNET_CAIP2));
    const chain = chainDouble({
      mint: ADDRESS,
      history: new Map(),
      blockHeight: 2n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    const results = await reconcileUptoBuyer({
      journal,
      network: SOLANA_MAINNET_CAIP2,
      rpc: chain.rpc,
      payer: ADDRESS,
      mint: ADDRESS,
      treasury: ADDRESS,
      expected: () => undefined,
      report: async () => {},
    });
    assert.equal(results.length, 1);
    assert.equal(
      (await journal.list())[0]?.state,
      PAYMENT_CHANNEL_STATES.SETTLED,
    );
    assert.notEqual(chain.reads.length, 0);
  });
});
