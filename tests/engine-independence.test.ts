import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
} from '@solana/kit';
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';

import { createInferenceSeller } from '../apps/seller/src/inference.js';
import { MODEL } from '../packages/inference-ollama/src/model.js';
import {
  CHANNEL_PROGRAM,
  DEVNET,
  DEVNET_GENESIS,
} from '../packages/payments-x402/src/constants.js';

// The real x402 middleware runs against controlled, non-broadcasting services.
// No wallet is funded and no RPC method can submit a transaction.
test('seller uses an injected Engine and generates only after confirmed valid escrow', async () => {
  const original = globalThis.fetch;
  const authorizer = await generateKeyPairSigner();
  const buyer = '5FVtvnKXCabCDxSoeNJuLdRpCTBZQnhTnNooZzEYfg2j',
    feePayer = 'HZLkSwMefjig2NhrKaW3Hb16JX8PTQnE4Jutdc2B433g',
    mint = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
  const encoder = getAddressEncoder();
  const [channelId, bump] = await getProgramDerivedAddress({
    programAddress: address(CHANNEL_PROGRAM),
    seeds: [
      Buffer.from('channel'),
      encoder.encode(address(buyer)),
      encoder.encode(address(feePayer)),
      encoder.encode(address(mint)),
      encoder.encode(authorizer.address),
      getU64Encoder().encode(1n),
      getU64Encoder().encode(1n),
    ],
  });
  const data = Buffer.alloc(256);
  data[0] = 1;
  data[1] = 1;
  data[2] = bump;
  data.writeBigUInt64LE(1n, 4);
  data.writeBigUInt64LE(148n, 12);
  data.writeUInt32LE(60, 52);
  for (const [value, offset] of [
    [buyer, 88],
    [feePayer, 120],
    [authorizer.address, 152],
    [mint, 184],
    [feePayer, 216],
  ] as const)
    data.set(encoder.encode(address(value)), offset);
  data.writeBigUInt64LE(1n, 248);
  let confirmed = false;
  const engine = {
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: 'digest' as const,
    }),
    describe: async () => ({
      name: 'synthetic-engine',
      digest: 'synthetic-digest',
      contextTokens: 2048,
    }),
    generate: async () => {
      assert.equal(confirmed, true);
      engineCalls++;
      return {
        text: 'answer',
        usage: {
          inputTokens: 10,
          outputTokens: 6,
          totalDurationNs: 1,
          loadDurationNs: 1,
          inputDurationNs: 1,
          outputDurationNs: 1,
        },
        finishReason: 'stop' as const,
      };
    },
  };
  let engineCalls = 0,
    releaseDeposit!: () => void,
    signalDeposit!: () => void;
  const depositBarrier = new Promise<void>((resolve) => {
    releaseDeposit = resolve;
  });
  const depositReached = new Promise<void>((resolve) => {
    signalDeposit = resolve;
  });
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith('https://facilitator.test/')) {
      if (url.endsWith('/supported'))
        return Response.json({
          kinds: [
            {
              x402Version: 2,
              scheme: 'upto',
              network: DEVNET,
              extra: { feePayer },
            },
          ],
          extensions: [],
          signers: {},
        });
      const body = JSON.parse(String(init?.body));
      if (url.endsWith('/verify'))
        return Response.json({ isValid: true, payer: buyer });
      if (url.endsWith('/settle')) {
        const phase = body.paymentPayload.payload.type;
        if (phase === 'deposit') {
          signalDeposit();
          await depositBarrier;
          confirmed = true;
        }
        return Response.json({
          success: true,
          payer: buyer,
          network: DEVNET,
          transaction: phase === 'deposit' ? 'mock-open' : 'mock-zero-claim',
          amount: body.paymentRequirements.amount,
        });
      }
    }
    if (url === 'https://rpc.test/') {
      const { method, params } = JSON.parse(String(init?.body));
      let result: unknown;
      if (method === 'getLatestBlockhash')
        result = {
          context: { slot: 1 },
          value: {
            blockhash: '11111111111111111111111111111111',
            lastValidBlockHeight: 1000,
          },
        };
      else if (method === 'getGenesisHash') result = DEVNET_GENESIS;
      else if (method === 'getProgramAccounts') result = [];
      else if (method === 'getAccountInfo')
        result = {
          value:
            params[0] === channelId
              ? {
                  owner: CHANNEL_PROGRAM,
                  data: [data.toString('base64'), 'base64'],
                }
              : {
                  owner: TOKEN_PROGRAM_ADDRESS,
                  data: {
                    parsed: {
                      info: {
                        owner: channelId,
                        mint,
                        tokenAmount: { amount: '148' },
                      },
                    },
                  },
                },
        };
      else throw new Error('Forbidden or unexpected mock RPC ' + method);
      return Response.json({
        jsonrpc: '2.0',
        id: JSON.parse(String(init?.body)).id,
        result,
      });
    }
    throw new Error('Unexpected outbound test request: ' + url);
  }) as typeof fetch;
  let server: Server | undefined;
  let depositDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const options = {
      engine,
      rpcUrl: 'https://rpc.test/',
      facilitatorUrl: 'https://facilitator.test',
      feePayer,
      ollamaUrl: 'http://127.0.0.1:11439',
      mint,
      payTo: buyer,
      authorizer,
      tokenizer: { input: () => 10, count: () => 6 },
      beforeInference: async () => {},
    };
    const host = await createInferenceSeller(options);
    server = host.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`,
      body = JSON.stringify({
        requestId: randomUUID(),
        prompt: 'Hi',
        maxTokens: 32,
      });
    const challenge = await original(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(challenge.status, 402);
    const required = decodePaymentRequiredHeader(
      challenge.headers.get('PAYMENT-REQUIRED')!,
    );
    const payment = {
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0]!,
      payload: {
        from: buyer,
        maxAmount: required.accepts[0]!.amount,
        deposit: required.accepts[0]!.amount,
        channelId,
        authorizedSigner: authorizer.address,
        openTransaction: 'controlled-wire-placeholder',
        openSlot: '1',
        expiresAt: Math.floor(Date.now() / 1000) + 120,
        validAfter: Math.floor(Date.now() / 1000) - 1,
        nonce: '1',
      },
    };
    const pending = original(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment),
      },
      body,
    });
    await Promise.race([
      depositReached,
      new Promise(
        (_, reject) =>
          (depositDeadline = setTimeout(
            () => reject(new Error('Deposit phase not reached')),
            10000,
          )),
      ),
    ]);
    clearTimeout(depositDeadline);
    assert.equal(engineCalls, 0);
    releaseDeposit();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(engineCalls, 1);
    const result = await response.json();
    assert.equal(result.content, 'answer');
    assert.equal(result.model, 'synthetic-engine');
    assert.equal(result.digest, 'synthetic-digest');
  } finally {
    clearTimeout(depositDeadline);
    releaseDeposit();
    globalThis.fetch = original;
    server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
  }
});
