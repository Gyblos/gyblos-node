// Observes synthetic finalized channel transfers without modifying the buyer's private journal.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';
import { UPTO_HISTORY_LIMIT, UPTO_HISTORY_PAGES } from 'x402-upto-metered';

import { buyerJournalPathsIn, DEVNET, DEVNET_GENESIS } from '@gyblos/config';
import { observeUptoBuyer } from '@gyblos/payments-upto';

import { ADDRESS, DIGEST, entry, withJournal } from './support/mainnet-journal';
import { chainDouble, signatureOf } from './support/upto-chain-history';

async function distinctEntry(network: string | null) {
  const values = await Promise.all(
    Array.from(
      { length: 5 },
      async () => (await generateKeyPairSigner()).address,
    ),
  );
  const [payer, mint, payTo, feePayer, treasury] = values;
  assert.ok(payer && mint && payTo && feePayer && treasury);
  return {
    payer,
    mint,
    treasury,
    value: {
      ...entry(network),
      payTo,
      feePayer,
      policy: { network, mint, treasury, protocolFeeBps: 300 },
    },
  };
}

void test('a finalized transfer is observed for one bound channel without changing the journal', async () => {
  await withJournal(async (journal, root) => {
    const identities = await Promise.all(
      Array.from(
        { length: 6 },
        async () => (await generateKeyPairSigner()).address,
      ),
    );
    const [payer, mint, channel, payTo, treasury, otherChannel] = identities;
    assert.ok(payer && mint && channel && payTo && treasury && otherChannel);
    await journal.put({
      ...entry(DEVNET),
      channelId: channel,
      payTo,
      policy: { network: DEVNET, mint, treasury, protocolFeeBps: 300 },
    });
    await journal.put({
      ...entry(DEVNET),
      requestDigest: 'cd'.repeat(32),
      channelId: otherChannel,
      payTo,
      policy: { network: DEVNET, mint, treasury, protocolFeeBps: 300 },
    });
    const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
    const before = await readFile(paths.state);
    const chain = chainDouble({
      mint,
      history: new Map([
        [
          channel,
          [
            {
              signature: signatureOf(1),
              flows: [
                { owner: channel, before: 1000n, after: 0n },
                { owner: payTo, before: 0n, after: 97n },
                { owner: payer, before: 0n, after: 900n },
                { owner: treasury, before: 0n, after: 3n },
              ],
            },
          ],
        ],
      ]),
      blockHeight: 100n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    const queried: string[] = [];
    const rpc = {
      ...chain.rpc,
      getSignaturesForAddress(
        account: Parameters<typeof chain.rpc.getSignaturesForAddress>[0],
        config: Parameters<typeof chain.rpc.getSignaturesForAddress>[1],
      ) {
        queried.push(String(account));
        return chain.rpc.getSignaturesForAddress(account, config);
      },
    };
    const result = await observeUptoBuyer({
      journal,
      network: DEVNET,
      requestDigest: DIGEST,
      rpc,
      payer,
      mint,
      treasury,
    });
    assert.deepEqual(result, { chargedAtomic: '100', refundedAtomic: '900' });
    assert.deepEqual(queried, [channel]);
    assert.deepEqual(await readFile(paths.state), before);
  });
});

void test('unknown network, another digest and absent settlement never produce a charge', async () => {
  for (const network of [null, SOLANA_MAINNET_CAIP2, DEVNET])
    await withJournal(async (journal, root) => {
      const { value, payer, mint, treasury } = await distinctEntry(network);
      await journal.put(value);
      const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
      const before = await readFile(paths.state);
      const chain = chainDouble({
        mint,
        history: new Map(),
        blockHeight: 2n,
        oldestSlot: 0n,
        accounts: new Set(),
      });
      let genesisReads = 0;
      const rpc = {
        ...chain.rpc,
        getGenesisHash: () => ({
          send: async () => {
            genesisReads++;
            return DEVNET.split(':')[1]!;
          },
        }),
      };
      const options = {
        journal,
        network: DEVNET,
        requestDigest: DIGEST,
        rpc,
        payer,
        mint,
        treasury,
      };
      assert.equal(
        await observeUptoBuyer({ ...options, requestDigest: 'cd'.repeat(32) }),
        undefined,
      );
      assert.equal(await observeUptoBuyer(options), undefined);
      if (network !== DEVNET) assert.equal(genesisReads, 0);
      assert.deepEqual(await readFile(paths.state), before);
    });
});

void test('overlapping payout parties are refused before any RPC observation', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(DEVNET));
    const chain = chainDouble({
      mint: ADDRESS,
      history: new Map(),
      blockHeight: 2n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    let reads = 0;
    const rpc = {
      ...chain.rpc,
      getGenesisHash: () => ({
        send: async () => {
          reads++;
          return DEVNET_GENESIS;
        },
      }),
    };
    assert.equal(
      await observeUptoBuyer({
        journal,
        network: DEVNET,
        requestDigest: DIGEST,
        rpc,
        payer: ADDRESS,
        mint: ADDRESS,
        treasury: ADDRESS,
      }),
      undefined,
    );
    assert.equal(reads, 0);
  });
});

void test('a settlement is not reported when bounded channel history is incomplete', async () => {
  await withJournal(async (journal, root) => {
    const { value, payer, mint, treasury } = await distinctEntry(DEVNET);
    await journal.put(value);
    const path = buyerJournalPathsIn({ GYBLOS_HOME: root }).state;
    const before = await readFile(path);
    const history = Array.from(
      { length: UPTO_HISTORY_LIMIT * UPTO_HISTORY_PAGES },
      (_, index) => ({
        signature: signatureOf(index),
        ...(index === 0
          ? {
              flows: [
                { owner: ADDRESS, before: 1000n, after: 0n },
                { owner: value.payTo, before: 0n, after: 97n },
                { owner: payer, before: 0n, after: 900n },
                { owner: treasury, before: 0n, after: 3n },
              ],
            }
          : {}),
      }),
    );
    const chain = chainDouble({
      mint,
      history: new Map([[ADDRESS, history]]),
      blockHeight: 100n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    assert.equal(
      await observeUptoBuyer({
        journal,
        network: DEVNET,
        requestDigest: DIGEST,
        rpc: chain.rpc,
        payer,
        mint,
        treasury,
      }),
      undefined,
    );
    assert.deepEqual(await readFile(path), before);
  });
});

void test('a different RPC network or cancelled inspection cannot read a settlement', async () => {
  await withJournal(async (journal, root) => {
    const { value, payer, mint, treasury } = await distinctEntry(DEVNET);
    await journal.put(value);
    const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
    const before = await readFile(paths.state);
    const chain = chainDouble({
      mint,
      history: new Map(),
      blockHeight: 2n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    const rpc = {
      ...chain.rpc,
      getGenesisHash: () => ({ send: async () => 'wrong-network' }),
    };
    const options = {
      journal,
      network: DEVNET,
      requestDigest: DIGEST,
      rpc,
      payer,
      mint,
      treasury,
    };
    await assert.rejects(observeUptoBuyer(options));
    await assert.rejects(
      observeUptoBuyer({ ...options, signal: AbortSignal.abort() }),
    );
    assert.deepEqual(chain.reads, []);
    assert.deepEqual(await readFile(paths.state), before);
  });
});

void test('a noncooperative RPC cannot hold the inspection past cancellation', async () => {
  await withJournal(async (journal, root) => {
    const { value, payer, mint, treasury } = await distinctEntry(DEVNET);
    await journal.put(value);
    const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
    const before = await readFile(paths.state);
    const chain = chainDouble({
      mint,
      history: new Map(),
      blockHeight: 2n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    const rpc = {
      ...chain.rpc,
      getEpochInfo: () => ({ send: () => new Promise<never>(() => {}) }),
    };
    const attempt = observeUptoBuyer({
      journal,
      network: DEVNET,
      requestDigest: DIGEST,
      rpc,
      payer,
      mint,
      treasury,
      signal: AbortSignal.timeout(20),
    });
    await assert.rejects(
      Promise.race([
        attempt,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout not enforced')), 500),
        ),
      ]),
      (error: unknown) =>
        error instanceof Error && error.message !== 'timeout not enforced',
    );
    assert.deepEqual(await readFile(paths.state), before);
  });
});
