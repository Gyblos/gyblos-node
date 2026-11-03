// Exercises one interrupted paid chat through local HTTP and an in-process chain double.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { runOwnedChat } from '@gyblos/buyer/chat-cli';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError, paidChat } from '@gyblos/buyer/paid-http';
import { buyerJournalPathsIn, DEVNET } from '@gyblos/config';
import { observeUptoBuyer } from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { PaidClientError } from '@gyblos/transport-iroh/paid-client';

import { setup } from './support/buyer-paid';
import { NOW, withJournal } from './support/mainnet-journal';
import { chainDouble, signatureOf } from './support/upto-chain-history';

void test('a cut observes only its finalized synthetic channel without changing the journal or retrying', async () => {
  await withJournal(async (journal, root) => {
    const buyer = await setup();
    const channel = (await generateKeyPairSigner()).address;
    const payer = (await generateKeyPairSigner()).address;
    const payTo = (await generateKeyPairSigner()).address;
    const feePayer = (await generateKeyPairSigner()).address;
    for (const winner of buyer.winners) {
      winner.quote.offer.buyer = payer;
      winner.quote.offer.payTo = payTo;
      winner.quote.offer.feePayer = feePayer;
    }
    const original = buyer.dependencies.payment.authorize.bind(
      buyer.dependencies.payment,
    );
    let chain: ReturnType<typeof chainDouble> | undefined;
    let identity: { payer: string; mint: string; treasury: string } | undefined;
    let before: Buffer | undefined;
    const path = buyerJournalPathsIn({ GYBLOS_HOME: root }).state;
    buyer.dependencies.payment = {
      ...buyer.dependencies.payment,
      async authorize(terms) {
        const authorization = await original(terms);
        await journal.put({
          requestDigest: terms.requestDigest,
          channelId: channel,
          payTo: terms.payTo,
          feePayer: terms.feePayer,
          maxAtomic: terms.maxAtomic,
          policy: {
            network: DEVNET,
            mint: terms.mint,
            treasury: terms.treasury,
            protocolFeeBps: terms.protocolFeeBps,
          },
          openSlot: '1',
          lastValidBlockHeight: '1',
          expiresAt: NOW + 60_000,
          state: PAYMENT_CHANNEL_STATES.OPEN,
          chargedAtomic: null,
        });
        identity = {
          payer: terms.buyer,
          mint: terms.mint,
          treasury: terms.treasury,
        };
        chain = chainDouble({
          mint: terms.mint,
          history: new Map([
            [
              channel,
              [
                {
                  signature: signatureOf(4),
                  flows: [
                    {
                      owner: channel,
                      before: BigInt(terms.maxAtomic),
                      after: 0n,
                    },
                    { owner: terms.payTo, before: 0n, after: 7n },
                    {
                      owner: terms.buyer,
                      before: 0n,
                      after: BigInt(terms.maxAtomic) - 7n,
                    },
                    { owner: terms.treasury, before: 0n, after: 0n },
                  ],
                },
              ],
            ],
          ]),
          blockHeight: 100n,
          oldestSlot: 0n,
          accounts: new Set(),
        });
        before = await readFile(path);
        return { ...authorization, channelId: channel };
      },
    };
    buyer.scripts.push(async (_request, emit) => {
      await emit('synthetic output');
      throw new PaidClientError(PAID_EXECUTION_CODES.TIMEOUT, true);
    });
    const paid = paidChat(buyer.dependencies);
    const output: string[] = [];
    let inspections = 0;
    await runOwnedChat(
      async () => {
        const host = await startFreeBuyerHttp(
          paid.execute,
          {
            selection: {
              modelId: 'synthetic',
              variant: null,
              quantization: null,
            },
            maxTokens: 50,
          },
          { port: 0, stream: paid.stream, classify: classifyPaidError },
        );
        return {
          chat: {
            model: 'synthetic',
            maxTokens: 50,
            maxAtomic: '10000',
            request: (_url, init) => fetch(host.url, init),
          },
          close: host.close,
          inspectAndClose: async (requestDigest) => {
            await host.close();
            inspections++;
            assert.ok(chain && identity && before);
            const result = await observeUptoBuyer({
              journal,
              network: DEVNET,
              requestDigest,
              rpc: chain.rpc,
              ...identity,
            });
            assert.deepEqual(await readFile(path), before);
            return result;
          },
        };
      },
      async () => 'synthetic prompt',
      (text) => output.push(text),
    );
    assert.equal(inspections, 1);
    assert.equal(buyer.calls.authorize.length, 1);
    assert.equal(buyer.calls.executed.length, 1);
    assert.match(output.join(''), /RPC reports finalized charge 7/);
    assert.match(output.join(''), /No retry was made/);
    assert.equal(
      output.join('').includes(buyer.calls.authorize[0]!.requestDigest),
      false,
    );
    assert.equal((await journal.list())[0]?.state, PAYMENT_CHANNEL_STATES.OPEN);
  });
});
