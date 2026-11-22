// Product desktop IPC/client and buyer HTTP compose over loopback; the buyer execution port is synthetic.
// No model, wallet funding, remote network, inference retries or transactions are used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createX402Handlers } from '@gyblos/desktop/x402-handlers';
import { X402_ACTION } from '@gyblos/desktop/x402-model';
import { automaticBuyer } from '@gyblos/desktop/x402-startup';
import {
  ENGINE_DONE_REASONS,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';

void test('initial desktop status enables free HTTP chat and presents the actual returned answer', async () => {
  let calls = 0;
  let saved: string | undefined;
  const budget = new X402Budget({
    read: async () => saved,
    write: async (text) => {
      saved = text;
    },
  });
  const token = 'synthetic-local-desktop-bearer';
  const host = await startFreeBuyerHttp(
    async () => {
      assert.equal((await budget.summary()).blocked, true);
      calls++;
      return {
        text: 'Synthetic local model answer',
        usage: { inputTokens: 4, outputTokens: 2 },
        finishReason: ENGINE_DONE_REASONS.STOP,
        execution: OFFER_PRICING_KINDS.FREE,
      };
    },
    {
      selection: {
        modelId: 'synthetic-desktop-model',
        variant: null,
        quantization: null,
      },
      maxTokens: 8,
    },
    {
      port: 0,
      token,
      desktopPolicy: {
        network: DEVNET,
        mint: DEVNET_USDC,
        payer: '11111111111111111111111111111111',
        maxAtomic: '0',
      },
    },
  );
  const client = new X402Client(budget);
  const managed = automaticBuyer(
    {
      start: async () => ({ url: host.url, token }),
      stop: () => host.close(),
      close: () => host.close(),
    },
    client,
    budget,
  );
  const contents = {};
  const frame = {};
  const handle = createX402Handlers(
    client,
    budget,
    { contents, mainFrame: () => frame, destroyed: () => false },
    async () => {
      throw new Error('External action forbidden');
    },
    managed,
  );
  const event = { sender: contents, senderFrame: frame };
  try {
    const initial = await handle(event, [{ action: X402_ACTION.STATUS }]);
    assert.equal(initial.error, undefined);
    assert.equal(initial.summary.active, true);
    assert.equal(initial.policy?.maxAtomic, '0');
    assert.equal(calls, 0);
    const unavailable = await handle(event, [
      {
        action: X402_ACTION.CONFIGURE_PAID,
        policyId: initial.policy?.policyId,
        maxAtomic: '10000',
        autoPrices: {
          inputAtomicPerMtok: '52000',
          outputAtomicPerMtok: '208000',
        },
      },
    ]);
    assert.match(unavailable.error ?? '', /does not support changing Auto/);
    assert.equal(client.policy()?.policyId, initial.policy?.policyId);
    const chat = new ChatController('synthetic-conversation');
    const model = {
      id: 'synthetic-desktop-model',
      name: 'Synthetic model',
      free: true,
      image: { src: '' },
    };
    const conversation = chat.startPaypal(
      'Synthetic question',
      model,
      'synthetic-request',
      initial.summary.sessionId ?? undefined,
      PAYMENT_METHOD.USDC,
    );
    assert.ok(conversation);
    const result = await handle(event, [
      {
        action: X402_ACTION.SEND,
        id: 'synthetic-request',
        prompt: 'Synthetic question',
      },
    ]);
    assert.ok(result.reply);
    chat.completePaypal(
      conversation,
      'synthetic-request',
      result.reply.text,
      model,
      result.reply.metrics,
    );
    assert.equal(
      chat.getSnapshot().sessions[0]?.messages.at(-1)?.text,
      'Synthetic local model answer',
    );
    assert.equal(calls, 1);
    assert.equal(result.summary.spentAtomic, '0');
    assert.equal(result.summary.records[0]?.free, true);
    assert.equal(result.summary.records[0]?.transaction, null);
  } finally {
    await client.close();
    await managed.close();
  }
});
