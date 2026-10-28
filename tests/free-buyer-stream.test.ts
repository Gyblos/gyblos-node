// Streaming HTTP/policy cases use synthetic ports only; no remote service or payment bootstrap.
import assert from 'node:assert/strict';
import test from 'node:test';

import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { freeSellerFixture } from './support/free-seller';

const settings = {
  selection: { modelId: 'synthetic', variant: null, quantization: null },
  maxTokens: 10,
};
const result = {
  text: 'firstsecond',
  usage: { inputTokens: 1, outputTokens: 2 },
  finishReason: ENGINE_DONE_REASONS.STOP,
};
const body = JSON.stringify({
  model: 'synthetic',
  messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
  stream: true,
});

void test('free HTTP delivers the first SSE delta before generation finishes and a verified terminal', async () => {
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let bufferedCalls = 0;
  const host = await startFreeBuyerHttp(
    async () => {
      bufferedCalls++;
      return result;
    },
    settings,
    {
      port: 0,
      stream: async (_input, signal, onDelta) => {
        assert.deepEqual(Object.keys(_input).sort(), ['maxTokens', 'messages']);
        await onDelta('first');
        await waiting;
        signal.throwIfAborted();
        await onDelta('second');
        return result;
      },
    },
  );
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/event-stream/,
    );
    assert.equal(response.headers.get('x-should-retry'), 'false');
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"content":"first"/);
    assert.doesNotMatch(first, /\[DONE\]/);
    finish();
    let rest = '';
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      rest += new TextDecoder().decode(part.value);
    }
    assert.match(rest, /"content":"second"/);
    assert.match(rest, /"finish_reason":"stop"/);
    assert.match(rest, /"total_tokens":3/);
    assert.match(rest, /data: \[DONE\]/);
    assert.equal(bufferedCalls, 0);
  } finally {
    finish();
    await host.close();
  }
});
void test('closing the HTTP stream cancels execution and prohibits later chunks', async () => {
  let cancelled = () => {};
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const host = await startFreeBuyerHttp(async () => result, settings, {
    port: 0,
    stream: async (_input, signal, onDelta) => {
      await onDelta('first');
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled();
            resolve();
          },
          { once: true },
        ),
      );
      await assert.rejects(onDelta('second'));
      throw new FreeClientError(FREE_EXECUTION_CODES.CANCELLED, true);
    },
  });
  const controller = new AbortController();
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /"content":"first"/,
    );
    controller.abort();
    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Cancellation not propagated')),
          3000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    controller.abort();
    await host.close();
  }
});
void test('a failure after streaming starts sends a static SSE error and no success terminal', async () => {
  const host = await startFreeBuyerHttp(async () => result, settings, {
    port: 0,
    stream: async (_input, _signal, onDelta) => {
      await onDelta('first');
      throw new Error('PRIVATE_ENGINE_PROMPT');
    },
  });
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"error"/);
    assert.doesNotMatch(text, /PRIVATE|\[DONE\]|"finish_reason":"stop"/);
    assert.equal(response.headers.get('x-should-retry'), 'false');
  } finally {
    await host.close();
  }
});
void test('observed streamed content prevents failover even if an injected port reports unsent', async () => {
  const fixture = await freeSellerFixture();
  const quote = (await fixture.request()).quote;
  let selections = 0;
  const fragments: string[] = [];
  await assert.rejects(
    executeBuyerFree(
      {
        messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
        maxTokens: 10,
      },
      {
        select: async () => {
          selections++;
          return { nodeId: 'seller', quote };
        },
        execute: async (_winner, _request, _signal, onDelta) => {
          await onDelta?.('first');
          throw new FreeClientError(FREE_EXECUTION_CODES.INTERNAL, false);
        },
      },
      undefined,
      async (text) => {
        fragments.push(text);
      },
    ),
  );
  assert.equal(selections, 1);
  assert.deepEqual(fragments, ['first']);
});

void test('free HTTP ends a stream with the stop reason and delivered usage when the seller cannot continue', async () => {
  const host = await startFreeBuyerHttp(async () => result, settings, {
    port: 0,
    stream: async (_input, _signal, onDelta) => {
      await onDelta('first');
      throw new FreeClientError(
        FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        true,
        true,
        {
          reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
          delivered: { outputTokens: 1 },
        },
      );
    },
  });
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"first"/);
    assert.doesNotMatch(text, /\[DONE\]/);
    assert.doesNotMatch(text, /"finish_reason":"(stop|length)"/);
    const last = text.trim().split('\n\n').at(-1) ?? '';
    assert.deepEqual(JSON.parse(last.replace(/^data: /, '')), {
      error: {
        message: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        type: 'gyblos_error',
        param: null,
        code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
        usage: { completion_tokens: 1 },
      },
    });
  } finally {
    await host.close();
  }
});
