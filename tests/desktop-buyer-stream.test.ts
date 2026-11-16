// Synthetic response streams and private in-memory permissions exercise the real desktop client.
// No wallets, engines, existing profiles or external services are used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { MESSAGE_STATE } from '@gyblos/desktop/chat-state';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import { AGENT_CHAT, OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

const policy: BuyerApiPolicy = {
  version: 1,
  policyId: '00000000-0000-4000-8000-000000000001',
  model: 'synthetic',
  maxTokens: 128,
  maxAtomic: '0',
  network: DEVNET,
  mint: DEVNET_USDC,
  payer: '11111111111111111111111111111111',
};
function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function chunk(content: string, terminal = false) {
  return {
    id: 'chatcmpl-synthetic',
    object: AGENT_CHAT.CHUNK,
    created: 1,
    model: policy.model,
    choices: [
      {
        index: 0,
        delta: terminal ? {} : { content },
        finish_reason: terminal ? 'stop' : null,
      },
    ],
    ...(terminal
      ? {
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          [BUYER_API.EXECUTION_FIELD]: OFFER_PRICING_KINDS.FREE,
        }
      : {}),
  };
}
const frame = (value: unknown) =>
  new TextEncoder().encode('data: ' + JSON.stringify(value) + '\n\n');
function setup(maxAtomic = '0') {
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  const budget = new X402Budget(files);
  const posted = latch();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let request: RequestInit | undefined;
  let posts = 0;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const client = new X402Client(budget, async (_url, options) => {
    if (options?.method !== 'POST')
      return Response.json({ ...policy, maxAtomic });
    posts++;
    request = options;
    options.signal?.addEventListener(
      'abort',
      () => controller.error(new DOMException('Stopped', 'AbortError')),
      { once: true },
    );
    controller.enqueue(frame(chunk('Hello')));
    posted.resolve();
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return {
    client,
    budget,
    files,
    posted,
    request: () => request,
    posts: () => posts,
    finish() {
      try {
        controller.enqueue(frame(chunk('', true)));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      } catch {
        /* The cancellation path already closed the synthetic body. */
      }
    },
  };
}
async function connect(value: ReturnType<typeof setup>, maxAtomic = '0') {
  await value.client.connect(
    'http://127.0.0.1:8090/v1/chat/completions',
    'synthetic-local-buyer-token',
  );
  await value.client.authorize(maxAtomic);
}

void test('desktop streams visible text before its terminal and completes one verified free request', async () => {
  const value = setup();
  await connect(value);
  const progress: string[] = [];
  const pending = value.client.send(
    'stream-one',
    'Synthetic question',
    (text) => progress.push(text),
  );
  const settled = Promise.allSettled([pending]);
  try {
    await value.posted.promise;
    await tick();
    assert.deepEqual(progress, ['Hello']);
    assert.equal(JSON.parse(String(value.request()?.body)).stream, true);
    assert.equal((await value.budget.summary()).records.length, 0);
    value.finish();
    const result = await pending;
    assert.equal(result.text, 'Hello');
    assert.equal(result.summary.blocked, false);
    assert.equal(result.summary.records[0]?.free, true);
    assert.equal(value.posts(), 1);
  } finally {
    value.finish();
    await settled;
    await value.client.close();
  }
});
for (const maxAtomic of ['0', '100']) {
  void test(`desktop stop retains partial text without retry; authority ${maxAtomic}`, async () => {
    const value = setup(maxAtomic);
    await connect(value, maxAtomic);
    const progress: string[] = [];
    const pending = value.client.send(
      'stopped-one',
      'Synthetic question',
      (text) => progress.push(text),
    );
    const settled = Promise.allSettled([pending]);
    try {
      await value.posted.promise;
      await tick();
      assert.equal(value.client.stop('unrelated-request'), false);
      assert.equal(value.client.stop('stopped-one'), true);
      assert.equal(value.request()?.signal?.aborted, true);
      await assert.rejects(pending);
      assert.deepEqual(progress, ['Hello']);
      const summary = await new X402Budget(value.files).summary();
      assert.equal(summary.blocked, maxAtomic !== '0');
      assert.equal(summary.spentAtomic, '0');
      assert.deepEqual(summary.records, []);
      assert.equal(value.posts(), 1);
    } finally {
      value.finish();
      await settled;
      await value.client.close();
    }
  });
}
void test('desktop stop while reserving prevents the first prompt write', async () => {
  const reserved = latch();
  const release = latch();
  let saved: string | undefined;
  const budget = new X402Budget({
    read: async () => saved,
    write: async (text) => {
      if (JSON.parse(text).pending) {
        reserved.resolve();
        await release.promise;
      }
      saved = text;
    },
  });
  let posts = 0;
  const client = new X402Client(budget, async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(policy);
    posts++;
    return Response.json({});
  });
  await client.connect(
    'http://127.0.0.1:8090/v1/chat/completions',
    'synthetic-local-buyer-token',
  );
  await client.authorize('0');
  const pending = client.send(
    'held-reservation',
    'Synthetic question',
    () => {},
  );
  const settled = Promise.allSettled([pending]);
  try {
    await reserved.promise;
    client.stop('held-reservation');
    release.resolve();
    await assert.rejects(pending);
    assert.equal(posts, 0);
    assert.equal((await budget.summary()).blocked, false);
  } finally {
    release.resolve();
    await settled;
    await client.close();
  }
});
void test('desktop controller retains stopped partials and rejects late or cross-conversation updates', () => {
  const chat = new ChatController('first');
  const model = {
    id: 'synthetic',
    name: 'Synthetic',
    image: { src: 'synthetic.svg' },
    free: true,
  };
  chat.startPaypal(
    'Synthetic question',
    model,
    'turn-one',
    undefined,
    PAYMENT_METHOD.USDC,
  );
  chat.appendBuyer('first', 'turn-one', 'Hello');
  assert.equal(chat.getSnapshot().sessions[0]?.messages.at(-1)?.text, 'Hello');
  chat.stopBuyer('first', 'turn-one');
  chat.newChat('second');
  chat.startPaypal(
    'Another question',
    model,
    'turn-two',
    undefined,
    PAYMENT_METHOD.USDC,
  );
  chat.appendBuyer('first', 'turn-one', ' late');
  chat.completePaypal('first', 'turn-one', 'Late terminal', model);
  assert.equal(chat.getSnapshot().sessions[0]?.messages.at(-1)?.text, 'Hello');
  assert.equal(
    chat.getSnapshot().sessions[0]?.messages.at(-1)?.state,
    MESSAGE_STATE.STOPPED,
  );
  assert.equal(chat.getSnapshot().sessions[1]?.messages.at(-1)?.text, '');
});
