// Only the owning frame receives bounded progress; Stop is request-scoped and never resends.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createX402Handlers } from '@gyblos/desktop/x402-handlers';
import {
  DESKTOP_X402,
  parseX402Progress,
  X402_ACTION,
  type X402Progress,
} from '@gyblos/desktop/x402-model';
import { AGENT_CHAT } from '@gyblos/protocol/constants';

void test('desktop progress boundary returns only the bounded request id and text', () => {
  assert.deepEqual(
    parseX402Progress({
      id: 'turn-one',
      text: 'A fragment',
      token: 'not-forwarded',
    }),
    { id: 'turn-one', text: 'A fragment' },
  );
  for (const value of [
    null,
    {},
    { id: 'turn', text: 1 },
    { id: '../turn', text: 'x' },
    { id: 'turn', text: 'x'.repeat(DESKTOP_X402.MAX_RESPONSE + 1) },
  ])
    assert.equal(parseX402Progress(value), null);
});
for (const navigation of [false, true]) {
  void test(`desktop handler protects progress and stop across frame navigation: ${navigation}`, async () => {
    const policy = {
      version: 1,
      policyId: '00000000-0000-4000-8000-000000000001',
      model: 'synthetic',
      maxTokens: 10,
      maxAtomic: '0',
      network: DEVNET,
      mint: DEVNET_USDC,
      payer: '11111111111111111111111111111111',
    };
    let saved: string | undefined;
    const budget = new X402Budget({
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
    });
    let body: ReadableStreamDefaultController<Uint8Array>;
    let posts = 0;
    let signal: AbortSignal | null | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    });
    const client = new X402Client(budget, async (_url, options) => {
      if (options?.method !== 'POST') return Response.json(policy);
      posts++;
      signal = options.signal;
      signal?.addEventListener(
        'abort',
        () => body.error(new DOMException('Stopped', 'AbortError')),
        { once: true },
      );
      body.enqueue(
        new TextEncoder().encode(
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl-one',
              object: AGENT_CHAT.CHUNK,
              created: 1,
              model: policy.model,
              choices: [
                {
                  index: 0,
                  delta: { content: 'A fragment' },
                  finish_reason: null,
                },
              ],
            }) +
            '\n\n',
        ),
      );
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    await client.connect(
      'http://127.0.0.1:8090/v1/chat/completions',
      'synthetic-local-buyer-token',
    );
    await client.authorize('0');
    const contents = {};
    let frame = {};
    const progress: X402Progress[] = [];
    const handle = createX402Handlers(
      client,
      budget,
      { contents, mainFrame: () => frame, destroyed: () => false },
      async () => {},
      undefined,
      undefined,
      (value) => progress.push(value),
    );
    const sender = { sender: contents, senderFrame: frame };
    const pending = handle(sender, [
      {
        action: X402_ACTION.SEND,
        id: 'turn-one',
        prompt: 'Synthetic question',
      },
    ]);
    const settled = Promise.allSettled([pending]);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(progress, [{ id: 'turn-one', text: 'A fragment' }]);
      await assert.rejects(() =>
        handle({ sender: {}, senderFrame: frame }, [
          { action: X402_ACTION.STOP, id: 'turn-one' },
        ]),
      );
      assert.equal(signal?.aborted, false);
      if (navigation) {
        frame = {};
        body!.enqueue(
          new TextEncoder().encode(
            'data: ' +
              JSON.stringify({
                id: 'chatcmpl-one',
                object: AGENT_CHAT.CHUNK,
                created: 1,
                model: policy.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: ' must not reach new frame' },
                    finish_reason: null,
                  },
                ],
              }) +
              '\n\n',
          ),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(progress, [{ id: 'turn-one', text: 'A fragment' }]);
      } else
        await handle(sender, [{ action: X402_ACTION.STOP, id: 'turn-one' }]);
      assert.equal(signal?.aborted, true);
      assert.ok((await pending).error);
      assert.equal((await budget.summary()).blocked, false);
      assert.equal(posts, 1);
    } finally {
      client.stop('turn-one');
      try {
        body!.close();
      } catch {
        /* Abort already terminated the synthetic stream. */
      }
      await settled;
      await client.close();
    }
  });
}
