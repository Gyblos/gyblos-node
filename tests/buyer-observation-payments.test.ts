// The real buyer payment wrapper observes a synthetic channel without signing or changing its journal.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { generateKeyPairSigner, type TransactionSigner } from '@solana/kit';

import {
  buyerJournalPathsIn,
  DEVNET,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import {
  openUptoBuyerJournal,
  openUptoBuyerPayments,
} from '@gyblos/payments-upto';

import { DIGEST, entry, NOW, withRoot } from './support/mainnet-journal';
import { chainDouble, signatureOf } from './support/upto-chain-history';

void test('the buyer payment wrapper reads one finalized synthetic channel without signing or journal writes', () =>
  withRoot(async (root) => {
    const signer = await generateKeyPairSigner();
    const values = await Promise.all(
      Array.from(
        { length: 4 },
        async () => (await generateKeyPairSigner()).address,
      ),
    );
    const [mint, channel, payTo, feePayer] = values;
    assert.ok(mint && channel && payTo && feePayer);
    let signed = 0;
    const payer: TransactionSigner = {
      address: signer.address,
      async signTransactions(transactions, config) {
        signed += transactions.length;
        return signer.signTransactions(transactions, config);
      },
    };
    const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
    const journal = await openUptoBuyerJournal({ paths, now: () => NOW });
    await journal.put({
      ...entry(DEVNET),
      channelId: channel,
      payTo,
      feePayer,
      policy: {
        network: DEVNET,
        mint,
        treasury: PROTOCOL_FEE.treasury,
        protocolFeeBps: PROTOCOL_FEE.bps,
      },
    });
    await journal.close();
    const before = await readFile(paths.state);
    const chain = chainDouble({
      mint,
      history: new Map([
        [
          channel,
          [
            {
              signature: signatureOf(9),
              flows: [
                { owner: channel, before: 1000n, after: 0n },
                { owner: payTo, before: 0n, after: 97n },
                { owner: signer.address, before: 0n, after: 900n },
                { owner: PROTOCOL_FEE.treasury, before: 0n, after: 3n },
              ],
            },
          ],
        ],
      ]),
      blockHeight: 100n,
      oldestSlot: 0n,
      accounts: new Set(),
    });
    const rpc = {
      ...chain.rpc,
      getLatestBlockhash: () => ({
        send: async () => ({
          value: { blockhash: channel, lastValidBlockHeight: 100n },
        }),
      }),
      getSlot: () => ({ send: async () => 1n }),
    };
    const payments = await openUptoBuyerPayments({
      rpcUrl: 'https://synthetic.invalid',
      policy: {
        network: DEVNET,
        mint,
        treasury: PROTOCOL_FEE.treasury,
        protocolFeeBps: PROTOCOL_FEE.bps,
        maxAtomic: '1000',
      },
      settings: UPTO_CHANNEL_SETTINGS,
      payer,
      paths,
      now: () => NOW,
      rpc,
      observationRpc: chain.rpc,
    });
    try {
      assert.ok(payments.observe);
      assert.deepEqual(await payments.observe(DIGEST), {
        chargedAtomic: '100',
        refundedAtomic: '900',
      });
      assert.equal(signed, 0);
      assert.deepEqual(await readFile(paths.state), before);
    } finally {
      await payments.close();
    }
  }));
