// Product desktop IPC/client and buyer SSE over loopback; inference is synthetic and financial calls are forbidden.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { paidChat, classifyPaidError } from '@gyblos/buyer/paid-http';
import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { MESSAGE_STATE } from '@gyblos/desktop/chat-state';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createX402Handlers } from '@gyblos/desktop/x402-handlers';
import { X402_ACTION } from '@gyblos/desktop/x402-model';
import {
  ENGINE_DONE_REASONS,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';

import { latch, tick } from './support/desktop-stream';
import { setup as paidSetup, header, settlement } from './support/buyer-paid';

void test('desktop HTTP streaming shows a partial, stops the original execution and can send a new free turn', async () => {
  const first = latch();
  const stopped = latch();
  let calls = 0;
  let saved: string | undefined;
  const budget = new X402Budget({
    read: async () => saved,
    write: async (text) => {
      saved = text;
    },
  });
  const host = await startFreeBuyerHttp(
    async () => {
      throw new Error('Only the streaming path is expected');
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
    },
    {
      port: 0,
      token: 'synthetic-local-buyer-token',
      desktopPolicy: {
        network: DEVNET,
        mint: DEVNET_USDC,
        payer: '11111111111111111111111111111111',
        maxAtomic: '0',
      },
      stream: async (_input, signal, onDelta) => {
        calls++;
        const call = calls;
        await onDelta(call === 1 ? 'Partial answer' : 'New answer');
        if (call === 1) {
          first.resolve();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => {
              stopped.resolve();
              reject(new Error('Synthetic cancellation'));
            };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
        }
        return {
          text: 'New answer',
          usage: { inputTokens: 2, outputTokens: 1 },
          finishReason: ENGINE_DONE_REASONS.STOP,
          execution: OFFER_PRICING_KINDS.FREE,
        };
      },
    },
  );
  const client = new X402Client(budget);
  const chat = new ChatController('conversation');
  const model = {
    id: 'synthetic',
    name: 'Synthetic',
    image: { src: 'synthetic.svg' },
    free: true,
  };
  const contents = {};
  const mainFrame = {};
  const event = { sender: contents, senderFrame: mainFrame };
  const arrived = latch();
  const handle = createX402Handlers(
    client,
    budget,
    { contents, mainFrame: () => mainFrame, destroyed: () => false },
    async () => {
      throw new Error('No external action');
    },
    undefined,
    undefined,
    (value) => {
      chat.appendBuyer('conversation', value.id, value.text);
      arrived.resolve();
    },
  );
  let pending: Promise<unknown> | undefined;
  try {
    await client.connect(host.url, 'synthetic-local-buyer-token');
    await client.authorize('0');
    chat.startPaypal(
      'Synthetic question',
      model,
      'first',
      undefined,
      PAYMENT_METHOD.USDC,
    );
    pending = handle(event, [
      { action: X402_ACTION.SEND, id: 'first', prompt: 'Synthetic question' },
    ]);
    await first.promise;
    await arrived.promise;
    assert.equal(
      chat.getSnapshot().sessions[0]?.messages.at(-1)?.text,
      'Partial answer',
    );
    assert.equal(
      chat.getSnapshot().sessions[0]?.messages.at(-1)?.state,
      MESSAGE_STATE.PENDING,
    );
    chat.stopBuyer('conversation', 'first');
    await handle(event, [{ action: X402_ACTION.STOP, id: 'first' }]);
    await pending;
    await stopped.promise;
    await tick();
    assert.equal(calls, 1);
    assert.equal(
      chat.getSnapshot().sessions[0]?.messages.at(-1)?.state,
      MESSAGE_STATE.STOPPED,
    );
    assert.equal((await budget.summary()).blocked, false);
    assert.deepEqual((await budget.summary()).records, []);
    chat.startPaypal(
      'New question',
      model,
      'second',
      undefined,
      PAYMENT_METHOD.USDC,
    );
    const response = await handle(event, [
      { action: X402_ACTION.SEND, id: 'second', prompt: 'New question' },
    ]);
    assert.ok(response.reply);
    chat.completePaypal(
      'conversation',
      'second',
      response.reply.text,
      model,
      response.reply.metrics,
    );
    assert.equal(calls, 2);
    assert.equal(
      chat.getSnapshot().sessions[0]?.messages.at(-1)?.text,
      'New answer',
    );
    assert.equal(
      chat.getSnapshot().sessions[0]?.messages.at(-1)?.state,
      MESSAGE_STATE.COMPLETE,
    );
    assert.equal(response.summary.records.length, 1);
    assert.equal(response.summary.records[0]?.free, true);
    assert.equal(response.summary.spentAtomic, '0');
  } finally {
    await client.close();
    await pending;
    await host.close();
  }
});
void test('desktop streaming preserves the existing confirmed paid producer without an execution marker', async () => {
  const buyer = await paidSetup();
  const transaction = '2'.repeat(88);
  const progress: string[] = [];
  buyer.scripts.push(async (request, onDelta) => {
    await onDelta('Hi.');
    return {
      ...(await header(request)),
      result: { text: 'Hi.', usage: { inputTokens: 4, outputTokens: 3 }, finishReason: ENGINE_DONE_REASONS.STOP },
      charge: { inputTokens: 4, outputTokens: 3, chargedAtomic: '1' },
      payment: { settlement: { ...settlement(request, '1'), transaction } },
    };
  });
  let saved: string | undefined;
  const budget = new X402Budget({ read: async () => saved, write: async (text) => { saved = text; } });
  const chat = paidChat(buyer.dependencies);
  const quote = buyer.winners[0]!.quote.offer;
  const host = await startFreeBuyerHttp(chat.execute,
    { selection: { modelId: 'synthetic', variant: null, quantization: null }, maxTokens: 10 },
    { port: 0, token: 'synthetic-local-buyer-token', stream: chat.stream, classify: classifyPaidError,
      desktopPolicy: { network: quote.network, mint: quote.mint, payer: quote.buyer, maxAtomic: quote.maxAtomic },
    });
  const client = new X402Client(budget);
  try {
    await client.connect(host.url, 'synthetic-local-buyer-token');
    await client.authorize(quote.maxAtomic);
    await assert.doesNotReject(async () => {
      const result = await client.send('paid-stream-one', 'Synthetic question', (text) => progress.push(text));
      assert.equal(result.text, 'Hi.');
      assert.equal(result.summary.records[0]?.transaction, transaction);
      assert.equal(result.summary.spentAtomic, '1');
      assert.equal(result.summary.blocked, false);
    });
    assert.deepEqual(progress, ['Hi.']);
    assert.equal(buyer.executed.length, 1);
  } finally { await client.close(); await host.close(); }
});
