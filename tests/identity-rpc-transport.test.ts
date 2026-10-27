// Bounds decoded registry responses before SDK parsing using synthetic fetch streams only.
// No real RPC, global fetch replacement, identity files, signers or payment calls.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_GENESIS } from '@gyblos/config';

const URL = 'https://rpc.invalid';
const LIMIT = 256;
async function factory() {
  return import('@gyblos/identity/resolution-rpc');
}
function responseBody(init: RequestInit, result: unknown = DEVNET_GENESIS) {
  const payload: unknown = JSON.parse(String(init.body));
  assert.ok(payload && typeof payload === 'object' && 'id' in payload);
  return JSON.stringify({ jsonrpc: '2.0', id: payload.id, result });
}
const headers = { 'content-type': 'application/json' };
void test('bounded RPC reads exact-limit JSON incrementally without whole-body Response helpers', async () => {
  const { createIdentityResolutionRpc } = await factory();
  const rpc = createIdentityResolutionRpc(URL, {
    maxResponseBytes: LIMIT,
    fetch: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      const body = responseBody(init);
      const response = new Response(body.padEnd(LIMIT), { headers });
      response.text = async () => {
        throw new Error('Unbounded text helper');
      };
      response.json = async () => {
        throw new Error('Unbounded JSON helper');
      };
      return response;
    },
  });
  assert.equal(await rpc.getGenesisHash().send(), DEVNET_GENESIS);
});
void test('excessive declared RPC size is refused before pulling or allocating a response buffer', async () => {
  const { createIdentityResolutionRpc } = await factory();
  let pulls = 0;
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulls++;
      },
      cancel() {
        cancels++;
      },
    },
    { highWaterMark: 0 },
  );
  const rpc = createIdentityResolutionRpc(URL, {
    maxResponseBytes: LIMIT,
    fetch: async () =>
      new Response(body, {
        headers: { ...headers, 'content-length': String(LIMIT + 1) },
      }),
  });
  await assert.rejects(rpc.getGenesisHash().send(), {
    code: 'IDENTITY_RPC_RESPONSE_TOO_LARGE',
  });
  assert.equal(pulls, 0);
  assert.equal(cancels, 1);
});
for (const length of [undefined, '1'])
  void test(`RPC incremental overflow cannot trust content-length ${length ?? 'absent'}`, async () => {
    const { createIdentityResolutionRpc } = await factory();
    let pulls = 0;
    let cancels = 0;
    let fetchSignal: AbortSignal | undefined;
    const rpc = createIdentityResolutionRpc(URL, {
      maxResponseBytes: LIMIT,
      fetch: async (_url, init) => {
        fetchSignal = init.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(new Uint8Array(100).fill(32));
            },
            cancel() {
              cancels++;
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          headers: {
            ...headers,
            ...(length ? { 'content-length': length } : {}),
          },
        });
      },
    });
    await assert.rejects(rpc.getGenesisHash().send(), {
      code: 'IDENTITY_RPC_RESPONSE_TOO_LARGE',
    });
    assert.equal(pulls, 3);
    assert.equal(cancels, 1);
    assert.equal(fetchSignal?.aborted, true);
  });
void test('RPC limit counts UTF-8 bytes rather than characters', async () => {
  const { createIdentityResolutionRpc } = await factory();
  const rpc = createIdentityResolutionRpc(URL, {
    maxResponseBytes: LIMIT,
    fetch: async (_url, init) =>
      new Response(responseBody(init, 'é'.repeat(120)), { headers }),
  });
  await assert.rejects(rpc.getGenesisHash().send(), {
    code: 'IDENTITY_RPC_RESPONSE_TOO_LARGE',
  });
});
void test('RPC rejects invalid UTF-8 and malformed or uncorrelated JSON envelopes with static errors', async () => {
  const { createIdentityResolutionRpc } = await factory();
  for (const body of [
    new Uint8Array([0xc3, 0x28]),
    'secret-not-json',
    '{"jsonrpc":"2.0","id":"foreign","result":"secret"}',
    '{}',
  ]) {
    const rpc = createIdentityResolutionRpc(URL, {
      fetch: async () => new Response(body, { headers }),
    });
    await assert.rejects(rpc.getGenesisHash().send(), {
      code: 'IDENTITY_RPC_RESPONSE_INVALID',
      message: 'IDENTITY_RPC_RESPONSE_INVALID',
    });
  }
});
void test('HTTP errors cancel their body without buffering arbitrary provider error contents', async () => {
  const { createIdentityResolutionRpc } = await factory();
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancels++;
    },
  });
  const rpc = createIdentityResolutionRpc(URL, {
    fetch: async () => new Response(body, { status: 503 }),
  });
  await assert.rejects(rpc.getGenesisHash().send(), {
    code: 'IDENTITY_RPC_TRANSPORT_FAILED',
    message: 'IDENTITY_RPC_TRANSPORT_FAILED',
  });
  assert.equal(cancels, 1);
});
void test('absolute RPC timeout cuts off a stalled body and does not wait for its cancellation', async () => {
  const { createIdentityResolutionRpc } = await factory();
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancels++;
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const rpc = createIdentityResolutionRpc(URL, {
    timeoutMs: 30,
    fetch: async () => new Response(body, { headers }),
  });
  const operation = rpc.getGenesisHash().send();
  // Keep the synthetic process alive while AbortSignal.timeout's timer is unreferenced.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(operation, { code: 'IDENTITY_READ_TIMEOUT' });
    assert.equal(cancels, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});
void test('caller cancellation cuts off RPC body reads and sanitizes arbitrary abort reasons', async () => {
  const { createIdentityResolutionRpc } = await factory();
  const controller = new AbortController();
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let cancelled = 0;
  const rpc = createIdentityResolutionRpc(URL, {
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              began();
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers },
      ),
  });
  const request = rpc.getGenesisHash().send({ abortSignal: controller.signal });
  await started;
  controller.abort('secret abort reason');
  await assert.rejects(request, {
    code: 'IDENTITY_RPC_CANCELLED',
    message: 'IDENTITY_RPC_CANCELLED',
  });
  assert.equal(cancelled, 1);
});
void test('a late fetch result is discarded after RPC timeout rather than parsed or trusted', async () => {
  const { createIdentityResolutionRpc } = await factory();
  let release = (_response: Response) => {};
  const later = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const rpc = createIdentityResolutionRpc(URL, {
    timeoutMs: 20,
    fetch: async () => later,
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(rpc.getGenesisHash().send(), {
      code: 'IDENTITY_READ_TIMEOUT',
    });
    let cancels = 0;
    release(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancels++;
          },
        }),
        { headers },
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancels, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});
void test('invalid RPC URL and limit configuration fail before any fetch', async () => {
  const { createIdentityResolutionRpc } = await factory();
  for (const url of [
    'http://remote.invalid',
    'https://user:secret@rpc.invalid',
    'https://rpc.invalid/?token=secret',
    'https://rpc.invalid/#secret',
  ])
    assert.throws(() => createIdentityResolutionRpc(url), {
      code: 'IDENTITY_RPC_REQUEST_INVALID',
    });
  for (const maxResponseBytes of [0, -1, 1.5, Infinity, 1048577])
    assert.throws(
      () => createIdentityResolutionRpc(URL, { maxResponseBytes }),
      { code: 'IDENTITY_RPC_REQUEST_INVALID' },
    );
});

void test('an elapsed RPC deadline discards an already returned unread body when timer dispatch was blocked', async () => {
  const { createIdentityResolutionRpc } = await factory();
  let cancelled = 0;
  const rpc = createIdentityResolutionRpc(URL, {
    timeoutMs: 20,
    fetch: async () => {
      const end = performance.now() + 40;
      while (performance.now() < end) {
        /* Synthetic blocked timer dispatch. */
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        }),
        { headers },
      );
    },
  });
  await assert.rejects(rpc.getGenesisHash().send(), {
    code: 'IDENTITY_READ_TIMEOUT',
  });
  assert.equal(cancelled, 1);
});

void test('RPC error envelopes do not expose arbitrary provider messages', async () => {
  const { createIdentityResolutionRpc } = await factory();
  const rpc = createIdentityResolutionRpc(URL, {
    fetch: async (_url, init) => {
      const request: unknown = JSON.parse(String(init.body));
      assert.ok(request && typeof request === 'object' && 'id' in request);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: 'secret provider text' },
        }),
      );
    },
  });
  await assert.rejects(rpc.getGenesisHash().send(), {
    code: 'IDENTITY_RPC_TRANSPORT_FAILED',
    message: 'IDENTITY_RPC_TRANSPORT_FAILED',
  });
});
void test('fragmented and empty chunks stay within the same decoded-byte budget', async () => {
  const { createIdentityResolutionRpc } = await factory();
  const rpc = createIdentityResolutionRpc(URL, {
    maxResponseBytes: LIMIT,
    fetch: async (_url, init) => {
      const bytes = new TextEncoder().encode(responseBody(init).padEnd(LIMIT));
      let offset = 0;
      let empty = true;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (offset === bytes.length) {
                controller.close();
                return;
              }
              if (empty) controller.enqueue(new Uint8Array());
              else controller.enqueue(bytes.subarray(offset++, offset));
              empty = !empty;
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  });
  assert.equal(await rpc.getGenesisHash().send(), DEVNET_GENESIS);
});
