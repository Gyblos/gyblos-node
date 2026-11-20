// Malformed, oversized and late local streams cannot complete a permission or retry a prompt.
import assert from 'node:assert/strict';
import test from 'node:test';

import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { DESKTOP_X402 } from '@gyblos/desktop/x402-model';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { FREE_STREAM, OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { chunk, frame, latch, policy, tick } from './support/desktop-stream';

const done = new TextEncoder().encode('data: [DONE]\n\n');
function scenario(chunks: Uint8Array[], maxAtomic = '0') {
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  const budget = new X402Budget(files);
  let posts = 0;
  const progress: string[] = [];
  const client = new X402Client(budget, async (_url, options) => {
    if (options?.method !== 'POST')
      return Response.json({ ...policy, maxAtomic });
    posts++;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const bytes of chunks) controller.enqueue(bytes);
        controller.close();
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return {
    client,
    budget,
    files,
    posts: () => posts,
    progress,
    async run() {
      await client.connect(
        'http://127.0.0.1:8090/v1/chat/completions',
        'synthetic-local-buyer-token',
      );
      await client.authorize(maxAtomic);
      return client.send('validation-one', 'Synthetic question', (text) =>
        progress.push(text),
      );
    },
  };
}
void test('desktop stream accepts fragmented UTF-8 and many tiny deltas without buffering the entire wire response', async () => {
  const count = 2000;
  const delta = frame(chunk('é'));
  const split = delta.indexOf(0xc3) + 1;
  const terminal = chunk('', true);
  const source = [
    delta.slice(0, split),
    delta.slice(split),
    ...Array.from({ length: count - 1 }, () => delta),
    frame(terminal),
    done,
  ];
  assert.ok(
    source.reduce((sum, value) => sum + value.byteLength, 0) >
      DESKTOP_X402.MAX_RESPONSE,
  );
  const value = scenario(source);
  try {
    const result = await value.run();
    assert.equal(result.text, 'é'.repeat(count));
    assert.equal(value.progress.join(''), result.text);
    assert.equal(value.posts(), 1);
  } finally {
    await value.client.close();
  }
});

const invalid = [
  { name: 'duplicate done', bytes: () => [frame(chunk('', true)), done, done] },
  {
    name: 'missing execution without payment',
    bytes: () => {
      const terminal: Record<string, unknown> = chunk('', true);
      delete terminal[BUYER_API.EXECUTION_FIELD];
      return [frame(terminal), done];
    },
  },
  {
    name: 'missing done',
    bytes: () => [frame(chunk('Hello')), frame(chunk('', true))],
  },
  {
    name: 'wrong model',
    bytes: () => [
      frame({ ...chunk('Hello'), model: 'wrong' }),
      frame(chunk('', true)),
      done,
    ],
  },
  {
    name: 'crossed response id',
    bytes: () => [
      frame(chunk('Hello')),
      frame({ ...chunk('', true), id: 'chatcmpl-other' }),
      done,
    ],
  },
  {
    name: 'changed creation time',
    bytes: () => [
      frame(chunk('Hello')),
      frame({ ...chunk('', true), created: 2 }),
      done,
    ],
  },
  { name: 'invalid UTF-8', bytes: () => [new Uint8Array([0xff])] },
  {
    name: 'malformed JSON',
    bytes: () => [new TextEncoder().encode('data: {\n\n')],
  },
  {
    name: 'trailing event',
    bytes: () => [frame(chunk('', true)), done, frame(chunk('late'))],
  },
  { name: 'missing terminal', bytes: () => [frame(chunk('Hello')), done] },
  {
    name: 'unknown execution',
    bytes: () => [
      frame({ ...chunk('', true), [BUYER_API.EXECUTION_FIELD]: 'unknown' }),
      done,
    ],
  },
  {
    name: 'unsupported tools',
    bytes: () => [
      frame({
        ...chunk(''),
        choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: null }],
      }),
      frame(chunk('', true)),
      done,
    ],
  },
  {
    name: 'excess output usage',
    bytes: () => [
      frame({
        ...chunk('', true),
        usage: { prompt_tokens: 2, completion_tokens: 129, total_tokens: 131 },
      }),
      done,
    ],
  },
  {
    name: 'excess decoded output',
    bytes: () => [
      frame(chunk('é'.repeat(DESKTOP_X402.MAX_RESPONSE / 2 + 1))),
      frame(chunk('', true)),
      done,
    ],
  },
  {
    name: 'excess unterminated frame',
    bytes: () => [
      new TextEncoder().encode(
        'data: ' + ' '.repeat(DESKTOP_X402.MAX_RESPONSE * 6 + 1024),
      ),
    ],
  },
  {
    name: 'excess events',
    bytes: () => [
      ...Array.from({ length: FREE_STREAM.maxEvents + 2 }, () =>
        frame(chunk('')),
      ),
      frame(chunk('', true)),
      done,
    ],
  },
];
for (const item of invalid) {
  void test(`desktop rejects ${item.name} without recording completion or retry`, async () => {
    const value = scenario(item.bytes(), '100');
    try {
      await assert.rejects(value.run());
      const summary = await new X402Budget(value.files).summary();
      assert.equal(summary.blocked, true);
      assert.deepEqual(summary.records, []);
      assert.equal(value.posts(), 1);
    } finally {
      await value.client.close();
    }
  });
}
void test('desktop enforces its aggregate wire cap even when every SSE frame is individually valid', async () => {
  const padded = frame({ ...chunk(''), padding: 'x'.repeat(1_000_000) });
  const value = scenario(
    [
      frame(chunk('Hello')),
      ...Array.from({ length: 36 }, () => padded),
      frame(chunk('', true)),
      done,
    ],
    '100',
  );
  try {
    await assert.rejects(value.run(), /too large/);
    assert.deepEqual((await value.budget.summary()).records, []);
    assert.equal(value.posts(), 1);
  } finally {
    await value.client.close();
  }
});
void test('desktop rejects an unverified paid stream terminal after showing its partial text', async () => {
  const value = scenario(
    [
      frame(chunk('Hello')),
      frame({
        ...chunk('', true),
        [BUYER_API.EXECUTION_FIELD]: OFFER_PRICING_KINDS.PAID,
        [BUYER_API.PAYMENT_FIELD]: { verdict: 'pending', chargedAtomic: null },
      }),
      done,
    ],
    '100',
  );
  try {
    await assert.rejects(value.run(), /not confirmed/);
    assert.deepEqual(value.progress, ['Hello']);
    assert.equal((await value.budget.summary()).blocked, true);
    assert.equal(value.posts(), 1);
  } finally {
    await value.client.close();
  }
});
void test('desktop accepts a confirmed paid stream terminal using the existing charge and refund checks', async () => {
  const value = scenario(
    [
      frame(chunk('Hello')),
      frame({
        ...chunk('', true),
        [BUYER_API.EXECUTION_FIELD]: OFFER_PRICING_KINDS.PAID,
        [BUYER_API.PAYMENT_FIELD]: {
          verdict: 'approved',
          maxAtomic: '100',
          expectedAtomic: '30',
          chargedAtomic: null,
          refundedAtomic: null,
          sellerAtomic: null,
          feeAtomic: null,
          recorded: true,
          session: {
            approvedAtomic: '30',
            cumulativeAtomic: '30',
            depositAtomic: '100',
          },
        },
      }),
      done,
    ],
    '100',
  );
  try {
    const result = await value.run();
    assert.equal(result.summary.spentAtomic, '30');
    assert.equal(result.summary.blocked, false);
    assert.equal(result.summary.records[0]?.transaction, null);
    assert.deepEqual(value.progress, ['Hello']);
  } finally {
    await value.client.close();
  }
});
void test('desktop cancellation rejects a response that arrives late from an abort-ignoring client', async () => {
  const sent = latch();
  const release = latch();
  let posts = 0;
  let saved: string | undefined;
  const budget = new X402Budget({
    read: async () => saved,
    write: async (text) => {
      saved = text;
    },
  });
  const client = new X402Client(budget, async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(policy);
    posts++;
    sent.resolve();
    await release.promise;
    return new Response(
      new Blob([frame(chunk('late')), frame(chunk('', true)), done]).stream(),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  await client.connect(
    'http://127.0.0.1:8090/v1/chat/completions',
    'synthetic-local-buyer-token',
  );
  await client.authorize('0');
  const progress: string[] = [];
  const pending = client.send('late-one', 'Synthetic question', (text) =>
    progress.push(text),
  );
  const settled = Promise.allSettled([pending]);
  try {
    await sent.promise;
    assert.equal(client.stop('late-one'), true);
    release.resolve();
    await assert.rejects(pending);
    await tick();
    assert.deepEqual(progress, []);
    assert.equal((await budget.summary()).blocked, false);
    assert.deepEqual((await budget.summary()).records, []);
    assert.equal(posts, 1);
  } finally {
    release.resolve();
    await settled;
    await client.close();
  }
});
