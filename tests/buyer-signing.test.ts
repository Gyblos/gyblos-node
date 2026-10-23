// Owns offline x402 buyer signing-order and rejection regressions; no funded wallets or live services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { generateKeyPairSigner } from '@solana/kit';
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';

import { createBuyer } from '@gyblos/payments-x402';
import { DEVNET, DEVNET_USDC } from '@gyblos/payments-x402/constants';
import { createInferenceBuyer } from '@gyblos/payments-x402/inference-buyer';

// Ephemeral local signatures only. The mock forbids every RPC or broadcast.
async function exercise(
  inference: boolean,
  untrusted = false,
  aborted = false,
) {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const signer = await generateKeyPairSigner();
  const feePayer = 'HZLkSwMefjig2NhrKaW3Hb16JX8PTQnE4Jutdc2B433g';
  const authorizer = '4hL4FcqMnrjMLnmyWzaSHhYiwV7FMjVr3CwnpehHNCV7';
  const events: string[] = [];
  const calls: unknown[] = [];
  const timeouts: number[] = [];
  const policy = {
    mint: DEVNET_USDC,
    payTo: feePayer,
    feePayer,
    receiverAuthorizer: authorizer,
    maxAtomic: '10000',
  };
  const accepted = {
    scheme: 'upto',
    network: DEVNET,
    amount: '10000',
    asset: DEVNET_USDC,
    payTo: untrusted ? authorizer : feePayer,
    maxTimeoutSeconds: 60,
    extra: {
      feePayer,
      receiverAuthorizer: authorizer,
      withdrawDelay: 60,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      recentBlockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: '1000',
      recentSlot: '1',
    },
  };
  const receipt = {
    success: true,
    network: DEVNET,
    payer: signer.address,
    transaction: 'mock-confirmed',
    amount: '140',
  };
  let resources = 0;
  AbortSignal.timeout = ((ms: number) => {
    timeouts.push(ms);
    return originalTimeout(ms);
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = (async (input, init) => {
    const request =
      input instanceof Request && !init ? input : new Request(input, init);
    assert.equal(request.url, 'https://resource.test/');
    if (request.signal.aborted) throw request.signal.reason;
    const headers = request.headers;
    const paid = headers.has('PAYMENT-SIGNATURE');
    calls.push({
      method: request.method,
      redirect: request.redirect,
      body:
        request.method === 'POST' ? await request.clone().text() : undefined,
      contentType: headers.get('content-type'),
      paid,
    });
    if (!paid)
      return Response.json(
        {},
        {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
              x402Version: 2,
              resource: {
                url: 'https://resource.test/',
                description: 'controlled test',
                mimeType: 'application/json',
              },
              accepts: [accepted],
            }),
          },
        },
      );
    events.push('paid-fetch');
    resources++;
    const response = Response.json(
      { value: 'controlled-result' },
      { headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(receipt) } },
    );
    const json = response.json.bind(response);
    const get = response.headers.get.bind(response.headers);
    response.json = async () => {
      events.push('body');
      return json();
    };
    response.headers.get = (name: string) => {
      if (name.toLowerCase() === 'payment-response') events.push('receipt');
      return get(name);
    };
    return response;
  }) as typeof fetch;
  try {
    const tracked = {
      ...signer,
      async signTransactions(
        ...args: Parameters<typeof signer.signTransactions>
      ) {
        events.push('sign');
        return signer.signTransactions(...args);
      },
    };
    const controller = new AbortController();
    if (aborted) controller.abort(new Error('controlled abort'));
    const invoke = inference
      ? createInferenceBuyer(tracked, 'https://rpc-forbidden.test/', policy, {
          beforeSigning: () => events.push('before-sign'),
          authorized: async () => {
            events.push('authorized');
          },
        })
      : createBuyer(
          tracked,
          'https://rpc-forbidden.test/',
          policy,
          fetch,
          async () => {
            events.push('authorized');
          },
        );
    if (untrusted || aborted) {
      await assert.rejects(
        async () =>
          typeof invoke === 'function'
            ? invoke(
                'https://resource.test/',
                { prompt: 'controlled' },
                controller.signal,
              )
            : invoke.request('https://resource.test/', controller.signal),
        aborted ? /controlled abort/ : /Wrong asset or recipient/,
      );
      assert.equal(resources, 0);
      assert.equal(events.includes('sign'), false);
      return { events, calls, timeouts };
    }
    const result =
      typeof invoke === 'function'
        ? await invoke(
            'https://resource.test/',
            { prompt: 'controlled' },
            controller.signal,
          )
        : await invoke.request('https://resource.test/', controller.signal);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { value: 'controlled-result' });
    assert.equal(resources, 1);
    assert.equal(timeouts[0], inference ? 180000 : 120000);
    assert.deepEqual(
      events.filter((e) => e !== 'receipt' && e !== 'body'),
      inference
        ? ['before-sign', 'sign', 'authorized', 'paid-fetch']
        : ['sign', 'authorized', 'paid-fetch'],
    );
    const bodyAt = events.indexOf('body');
    const receiptAt = events.lastIndexOf('receipt');
    assert.ok(
      inference ? bodyAt < receiptAt : receiptAt < bodyAt,
      JSON.stringify({ inference, events }),
    );
    return { events, calls, timeouts };
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
}

void test('shared buyer preserves GET/POST signing hooks transport timeout and receipt order', async () => {
  for (const inference of [false, true]) {
    const result = await exercise(inference);
    assert.equal(result.calls.length, 2);
    for (const call of result.calls as {
      method: string;
      redirect: string;
      body?: string;
      paid: boolean;
      contentType: string | null;
    }[]) {
      assert.equal(call.method, inference ? 'POST' : 'GET');
      assert.equal(call.redirect, 'error');
      assert.equal(
        call.body,
        inference ? JSON.stringify({ prompt: 'controlled' }) : undefined,
      );
      assert.equal(call.contentType, inference ? 'application/json' : null);
    }
    assert.deepEqual(
      result.calls.map((call) => (call as { paid: boolean }).paid),
      [false, true],
    );
  }
});
void test('shared buyer rejects untrusted terms and pre-aborted requests without signing', async () => {
  for (const inference of [false, true])
    for (const [bad, abort] of [
      [true, false],
      [false, true],
    ])
      await exercise(inference, bad, abort);
});
