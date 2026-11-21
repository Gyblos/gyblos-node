// Owns the seller's answer to an RPC that says "too many requests" (HTTP 429): wait what Retry-After asks,
// within a bounded budget, and try again, instead of failing a buyer's channel at once. Any other answer
// passes through untouched. Waits are injected, so no test sleeps.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';

import {
  generateKeyPairSigner,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from '@solana/kit';
import { toFacilitatorSvmSigner } from '@x402/svm';

import { DEVNET, DEVNET_GENESIS } from '@gyblos/config';
import { readGenesis } from '@gyblos/node/seller-chain';
import {
  rateLimitedFacilitatorRpc,
  rateLimitedFetch,
  rateLimitedSolanaRpc,
  rateLimitedTransport,
  RPC_RATE_LIMIT,
} from '@gyblos/payments-upto/rpc-rate-limit';

const limited = (headers: Record<string, string> = {}) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(headers),
    message: 'Too Many Requests',
    statusCode: 429,
  });
const request = { payload: { jsonrpc: '2.0', id: 1, method: 'getSlot' } };

function waits() {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

void test('a 429 is retried after the Retry-After seconds, then answers', async () => {
  const clock = waits();
  let calls = 0;
  const transport = rateLimitedTransport(
    async () => {
      calls += 1;
      if (calls < 3) throw limited({ 'retry-after': '2' });
      return { result: 7 } as never;
    },
    { sleep: clock.sleep },
  );
  assert.deepEqual(await transport(request), { result: 7 });
  assert.equal(calls, 3);
  assert.deepEqual(clock.slept, [2000, 2000]);
});

void test('waits are capped and follow backoff without Retry-After, up to the retry count', async () => {
  const clock = waits();
  let calls = 0;
  const transport = rateLimitedTransport(
    async () => {
      calls += 1;
      throw limited(calls === 1 ? { 'retry-after': '3600' } : {});
    },
    { sleep: clock.sleep },
  );
  await assert.rejects(transport(request), (error: unknown) => {
    assert.ok(error instanceof SolanaError);
    return true;
  });
  assert.equal(calls, RPC_RATE_LIMIT.retries + 1);
  assert.deepEqual(clock.slept, [RPC_RATE_LIMIT.maxWaitMs, 1000, 2000]);
});

void test('the wait budget stops retries before the count does', async () => {
  const clock = waits();
  let calls = 0;
  const transport = rateLimitedTransport(
    async () => {
      calls += 1;
      throw limited({ 'retry-after': '3600' });
    },
    { sleep: clock.sleep },
  );
  await assert.rejects(transport(request));
  assert.deepEqual(clock.slept, [
    RPC_RATE_LIMIT.maxWaitMs,
    RPC_RATE_LIMIT.maxWaitMs,
  ]);
  assert.equal(calls, 3);
});

void test('a real wait is cut short by cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = rateLimitedTransport(async () => {
    calls += 1;
    setTimeout(() => controller.abort(new Error('cancelled')), 20);
    throw limited({ 'retry-after': '3' });
  });
  const started = performance.now();
  await assert.rejects(transport({ ...request, signal: controller.signal }));
  assert.ok(performance.now() - started < 1000);
  assert.equal(calls, 1);
});

void test('other failures and HTTP errors pass through without a retry', async () => {
  for (const failure of [
    new Error('fetch failed'),
    new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
      headers: new Headers(),
      message: 'Internal Server Error',
      statusCode: 500,
    }),
  ]) {
    const clock = waits();
    let calls = 0;
    const transport = rateLimitedTransport(
      async () => {
        calls += 1;
        throw failure;
      },
      { sleep: clock.sleep },
    );
    await assert.rejects(transport(request), (error) => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(clock.slept, []);
  }
});

void test('a cancelled request stops waiting and is not sent again', async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = rateLimitedTransport(
    async () => {
      calls += 1;
      throw limited({ 'retry-after': '1' });
    },
    {
      sleep: async () => {
        controller.abort(new Error('cancelled'));
      },
    },
  );
  await assert.rejects(
    transport({ ...request, signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(calls, 1);
});

void test('an HTTP-date Retry-After is honoured', async () => {
  const clock = waits();
  let calls = 0;
  const now = Date.parse('2026-11-21T12:00:00Z');
  const transport = rateLimitedTransport(
    async () => {
      calls += 1;
      if (calls === 1)
        throw limited({ 'retry-after': 'Sat, 21 Nov 2026 12:00:01 GMT' });
      return 'ok' as never;
    },
    { sleep: clock.sleep, now: () => now },
  );
  assert.equal(await transport(request), 'ok');
  assert.deepEqual(clock.slept, [1000]);
});

void test('fetch: a 429 response is retried and its body released; others are returned as they are', async () => {
  const clock = waits();
  const answers = [
    new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '1' },
    }),
    new Response('{"ok":true}', { status: 200 }),
  ];
  let calls = 0;
  const fetcher = rateLimitedFetch(
    async () => {
      calls += 1;
      return answers.shift()!;
    },
    { sleep: clock.sleep },
  );
  const response = await fetcher('https://rpc.example.com', {
    method: 'POST',
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(clock.slept, [1000]);
  const failing = rateLimitedFetch(
    async () => new Response('', { status: 503 }),
    { sleep: clock.sleep },
  );
  assert.equal((await failing('https://rpc.example.com', {})).status, 503);
});

// A local JSON-RPC server that answers 429 to its first request, then `result` to every other.
async function limitedOnce(t: TestContext, result: unknown) {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(429, { 'retry-after': '0' }).end('slow down');
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: 0, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls: () => calls };
}

void test('a real Solana RPC client rides out an HTTP 429 from the server', async (t) => {
  const server = await limitedOnce(t, 'genesis-hash');
  const rpc = rateLimitedSolanaRpc(server.url);
  assert.equal(await rpc.getGenesisHash().send(), 'genesis-hash');
  assert.equal(server.calls(), 2);
});

void test("the SDK's facilitator signer uses the client and rides out a 429", async (t) => {
  const server = await limitedOnce(t, 42);
  const signer = toFacilitatorSvmSigner(
    await generateKeyPairSigner(),
    rateLimitedFacilitatorRpc(server.url),
  );
  assert.equal(await signer.getSlot!(DEVNET), 42n);
  assert.equal(server.calls(), 2);
});

void test("the seller's genesis read rides out a 429", async (t) => {
  const server = await limitedOnce(t, DEVNET_GENESIS);
  assert.equal(await readGenesis(server.url), DEVNET_GENESIS);
  assert.equal(server.calls(), 2);
});
