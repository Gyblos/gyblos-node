// Composes the bounded synthetic RPC transport with the buyer's finalized channel observer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { buyerJournalPathsIn, DEVNET, DEVNET_GENESIS } from '@gyblos/config';
import {
  createBuyerObservationRpc,
  observeUptoBuyer,
} from '@gyblos/payments-upto';

import { DIGEST, entry, withJournal } from './support/mainnet-journal';
import { signatureOf } from './support/upto-chain-history';

void test('bounded RPC transport and finalized history compose for the selected channel', async () => {
  await withJournal(async (journal, root) => {
    const identities = await Promise.all(
      Array.from(
        { length: 5 },
        async () => (await generateKeyPairSigner()).address,
      ),
    );
    const [payer, mint, channel, payTo, treasury] = identities;
    assert.ok(payer && mint && channel && payTo && treasury);
    await journal.put({
      ...entry(DEVNET),
      channelId: channel,
      payTo,
      policy: { network: DEVNET, mint, treasury, protocolFeeBps: 300 },
    });
    const path = buyerJournalPathsIn({ GYBLOS_HOME: root }).state;
    const before = await readFile(path);
    const signature = signatureOf(2);
    const flows = [
      {
        accountIndex: 0,
        mint,
        owner: channel,
        uiTokenAmount: { amount: '1000' },
      },
      { accountIndex: 1, mint, owner: payTo, uiTokenAmount: { amount: '0' } },
      { accountIndex: 2, mint, owner: payer, uiTokenAmount: { amount: '0' } },
      {
        accountIndex: 3,
        mint,
        owner: treasury,
        uiTokenAmount: { amount: '0' },
      },
    ];
    const after = flows.map((flow, index) => ({
      ...flow,
      uiTokenAmount: { amount: ['0', '97', '900', '3'][index] },
    }));
    const rpc = createBuyerObservationRpc(
      'https://synthetic.invalid',
      async (_url, init) => {
        const request: unknown = JSON.parse(String(init.body));
        assert.ok(
          request &&
            typeof request === 'object' &&
            'id' in request &&
            'method' in request,
        );
        const results: Record<string, unknown> = {
          getGenesisHash: DEVNET_GENESIS,
          getEpochInfo: { absoluteSlot: 1000, blockHeight: 100 },
          getSignaturesForAddress: [{ signature, err: null }],
          getTransaction: {
            meta: {
              err: null,
              preTokenBalances: flows,
              postTokenBalances: after,
            },
            transaction: { message: { accountKeys: [channel] } },
          },
        };
        assert.ok(typeof request.method === 'string');
        const method = request.method;
        assert.ok(Object.hasOwn(results, method));
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: results[method],
          }),
        );
      },
    );
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
    flows[0]!.uiTokenAmount.amount = '2000';
    assert.equal(
      await observeUptoBuyer({
        journal,
        network: DEVNET,
        requestDigest: DIGEST,
        rpc,
        payer,
        mint,
        treasury,
      }),
      undefined,
    );
    assert.deepEqual(await readFile(path), before);
  });
});
