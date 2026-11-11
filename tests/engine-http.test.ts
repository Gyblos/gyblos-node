// Bounded HTTP readers shared by engine adapters: server-sent events across arbitrary chunk splits,
// line endings and comments, and caps on one event and on the whole stream. Synthetic streams only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BoundFailure } from '@gyblos/core/engine-failures';
import { boundedText, serverSentData } from '@gyblos/core/engine-http';

const LIMITS = { eventCharacters: 64, streamCharacters: 256 };

function body(...parts: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function events(stream: ReadableStream<Uint8Array>) {
  const seen: string[] = [];
  for await (const data of serverSentData(stream, LIMITS)) seen.push(data);
  return seen;
}

void test('events survive any split, CRLF/CR/LF endings, comments and other fields', async () => {
  const text =
    ': keep-alive\r\nevent: message\r\ndata: one\r\n\r\ndata: two\rdata: lines\r\rdata: three\n\ndata: last';
  for (let size = 1; size <= text.length; size++) {
    const parts: string[] = [];
    for (let at = 0; at < text.length; at += size)
      parts.push(text.slice(at, at + size));
    assert.deepEqual(
      await events(body(...parts)),
      ['one', 'two\nlines', 'three', 'last'],
      `split ${size}`,
    );
  }
});

void test('an event or a whole stream over its cap is a bound failure', async () => {
  await assert.rejects(
    events(body(`data: ${'x'.repeat(65)}\n\n`)),
    BoundFailure,
  );
  await assert.rejects(
    events(body(...Array.from({ length: 10 }, () => `: ${'x'.repeat(30)}\n`))),
    BoundFailure,
  );
});

void test('a body over its byte cap is a bound failure', async () => {
  assert.equal(await boundedText(new Response('ok'), 2), 'ok');
  await assert.rejects(boundedText(new Response('too long'), 2), BoundFailure);
});

void test('provider adapters refuse an unsupported prompt before an aborted signal, as the port orders them', async () => {
  const { createAnthropicEngine } =
    await import('@gyblos/engine-anthropic/engine');
  const { createOpenAiEngine } = await import('@gyblos/engine-openai/engine');
  const controller = new AbortController();
  controller.abort(new Error('synthetic abort'));
  const input = {
    messages: [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
    ],
    maxTokens: 8,
    signal: controller.signal,
  };
  const never = async (): Promise<Response> => {
    throw new Error('no call expected');
  };
  for (const engine of [
    createOpenAiEngine(
      {
        base: 'https://api.example.com/v1',
        model: 'm',
        contextTokens: 4096,
        recountable: false,
      },
      never,
    ),
    createAnthropicEngine(
      {
        base: 'https://api.example.com',
        model: 'm',
        contextTokens: 4096,
        apiKey: 'k',
      },
      never,
    ),
  ])
    await assert.rejects(engine.generate(input), /Unsupported conversation/);
});
