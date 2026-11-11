// Runs the actual desktop HTTP client and buyer orchestrator over loopback with synthetic payment/engine ports.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError, paidChat } from '@gyblos/buyer/paid-http';
import { DEVNET } from '@gyblos/config';
import { BuyerRoutingError } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

import { header, settlement, setup } from './support/buyer-paid';

void test('desktop-to-buyer loopback records the hash only after buyer receipt verification', async () => {
  const buyer = await setup();
  const text = 'Hi.';
  const transaction = '2'.repeat(88);
  buyer.scripts.push(async (request, onDelta) => {
    await onDelta(text);
    return {
      ...(await header(request)),
      result: {
        text,
        usage: { inputTokens: 4, outputTokens: 3 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      },
      charge: { inputTokens: 4, outputTokens: 3, chargedAtomic: '1' },
      payment: { settlement: { ...settlement(request, '1'), transaction } },
    };
  });
  let saved: string | undefined;
  const budget = new X402Budget({
    read: async () => saved,
    write: async (value) => {
      saved = value;
    },
  });
  const chat = paidChat(buyer.dependencies);
  const quote = buyer.winners[0]!.quote.offer;
  const token = 'synthetic-loopback-bearer-token';
  const host = await startFreeBuyerHttp(
    async (input, signal) => {
      assert.equal(
        (await budget.summary()).blocked,
        true,
        'permission must be durably reserved before this request',
      );
      return chat.execute(input, signal);
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
    },
    {
      port: 0,
      token,
      classify: classifyPaidError,
      desktopPolicy: {
        network: quote.network,
        mint: quote.mint,
        payer: quote.buyer,
        maxAtomic: quote.maxAtomic,
      },
    },
  );
  const client = new X402Client(budget);
  try {
    await client.connect(host.url, token);
    await client.authorize(quote.maxAtomic);
    const response = await client.send('loopback-request', 'Hello');
    assert.equal(response.text, text);
    assert.equal(response.summary.records[0]?.transaction, transaction);
    assert.equal(response.summary.spentAtomic, '1');
    assert.equal(response.summary.blocked, false);
  } finally {
    await client.close();
    await host.close();
  }
});

void test('desktop routing refusals release only proven unsent reservations and never retry', async () => {
  for (const error of [
    new BuyerRoutingError(BUYER_ROUTING_CODES.BUSY),
    new BuyerRoutingError(BUYER_ROUTING_CODES.QUEUE_TIMEOUT),
    new Error('Synthetic uncertain failure'),
  ]) {
    let calls = 0;
    let saved: string | undefined;
    const budget = new X402Budget({
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
    });
    const host = await startFreeBuyerHttp(
      async () => {
        calls++;
        throw error;
      },
      {
        selection: { modelId: 'synthetic', variant: null, quantization: null },
        maxTokens: 10,
      },
      {
        port: 0,
        token: 'synthetic-loopback-bearer-token',
        classify: classifyPaidError,
        desktopPolicy: {
          network: DEVNET,
          mint: '11111111111111111111111111111111',
          payer: '11111111111111111111111111111111',
          maxAtomic: '100',
        },
      },
    );
    const client = new X402Client(budget);
    try {
      await client.connect(host.url, 'synthetic-loopback-bearer-token');
      await client.authorize('100');
      await assert.rejects(() =>
        client.send('refused-request', 'Synthetic question'),
      );
      const uncertain = !(error instanceof BuyerRoutingError);
      assert.equal((await budget.summary()).blocked, uncertain);
      assert.equal((await budget.summary()).spentAtomic, '0');
      if (uncertain)
        await assert.rejects(() =>
          client.send('blocked-request', 'Do not send'),
        );
      assert.equal(calls, 1);
    } finally {
      await client.close();
      await host.close();
    }
  }
});
