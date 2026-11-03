// A synthetic provider checks response bounds and static errors without network access.
import assert from 'node:assert/strict';
import test from 'node:test';

import { signature as asSignature } from '@solana/kit';

import {
  BUYER_OBSERVATION,
  createBuyerObservationRpc,
} from '@gyblos/payments-upto';

import { signatureOf } from './support/upto-chain-history';

void test('the observation RPC rejects a response above its decoded byte cap', async () => {
  let calls = 0;
  const rpc = createBuyerObservationRpc(
    'https://synthetic.invalid',
    async () => {
      calls++;
      return new Response('x'.repeat(BUYER_OBSERVATION.maxResponseBytes + 1));
    },
  );
  await assert.rejects(
    rpc.getGenesisHash().send(),
    (error: unknown) =>
      error instanceof Error && !error.message.includes('synthetic.invalid'),
  );
  assert.equal(calls, 1);
});

void test('the observation RPC accepts only the matching response envelope', async () => {
  for (const valid of [true, false]) {
    const rpc = createBuyerObservationRpc(
      'https://synthetic.invalid',
      async (_url, init) => {
        const request: unknown = JSON.parse(String(init.body));
        assert.ok(request && typeof request === 'object' && 'id' in request);
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: valid ? request.id : 'different',
            result: 'synthetic-genesis',
          }),
        );
      },
    );
    if (valid)
      assert.equal(await rpc.getGenesisHash().send(), 'synthetic-genesis');
    else await assert.rejects(rpc.getGenesisHash().send());
  }
});

void test('an aborted observation does not wait for an uncooperative provider', async () => {
  const rpc = createBuyerObservationRpc(
    'https://synthetic.invalid',
    async () => new Promise<never>(() => {}),
  );
  const attempt = rpc
    .getGenesisHash()
    .send({ abortSignal: AbortSignal.timeout(20) });
  await assert.rejects(
    Promise.race([
      attempt,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('deadline was ignored')), 500),
      ),
    ]),
    (error: unknown) =>
      error instanceof Error && error.message !== 'deadline was ignored',
  );
});

void test('an aborted observation does not wait for a stalled response body', async () => {
  const rpc = createBuyerObservationRpc(
    'https://synthetic.invalid',
    async () =>
      new Response(
        new ReadableStream({ pull: () => new Promise<void>(() => {}) }),
      ),
  );
  const attempt = rpc
    .getGenesisHash()
    .send({ abortSignal: AbortSignal.timeout(20) });
  await assert.rejects(
    Promise.race([
      attempt,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('deadline was ignored')), 500),
      ),
    ]),
    (error: unknown) =>
      error instanceof Error && error.message !== 'deadline was ignored',
  );
});

void test('invalid UTF-8 and HTTP errors fail without exposing the RPC URL', async () => {
  for (const response of [
    new Response(Uint8Array.of(0xff)),
    new Response('private error', { status: 503 }),
  ]) {
    const rpc = createBuyerObservationRpc(
      'https://synthetic.invalid/?key=private',
      async () => response,
    );
    await assert.rejects(
      rpc.getGenesisHash().send(),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('private') &&
        !error.message.includes('synthetic.invalid'),
    );
  }
});

void test('a misleading length and fragmented oversized body are still refused', async () => {
  const rpc = createBuyerObservationRpc(
    'https://synthetic.invalid',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(BUYER_OBSERVATION.maxResponseBytes),
            );
            controller.enqueue(Uint8Array.of(1));
            controller.close();
          },
        }),
        { headers: { 'content-length': '1' } },
      ),
  );
  await assert.rejects(rpc.getGenesisHash().send());
});

void test('an unlisted RPC method is rejected before the provider is contacted', async () => {
  let calls = 0;
  const rpc = createBuyerObservationRpc(
    'https://synthetic.invalid',
    async () => {
      calls++;
      return new Response();
    },
  );
  const { address } = await import('@solana/kit');
  await assert.rejects(
    rpc.getBalance(address('11111111111111111111111111111111')).send(),
  );
  assert.equal(calls, 0);
});

void test('transaction token balances reject oversized numeric strings before recounting', async () => {
  const rpc = createBuyerObservationRpc(
    'https://synthetic.invalid',
    async (_url, init) => {
      const request: unknown = JSON.parse(String(init.body));
      assert.ok(request && typeof request === 'object' && 'id' in request);
      const balance = { uiTokenAmount: { amount: '9'.repeat(10000) } };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            meta: { preTokenBalances: [balance], postTokenBalances: [] },
          },
        }),
      );
    },
  );
  await assert.rejects(
    rpc
      .getTransaction(asSignature(signatureOf(1)), {
        commitment: 'finalized',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send(),
  );
});
