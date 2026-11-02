// Synthetic terminal boundary for the real buyer CLI; no wallet, RPC or external services.
import assert from 'node:assert/strict';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';

import { main, runTerminal } from '@gyblos/buyer/chat-cli';

void test('terminal starts and closes its owned buyer using injected input and output', async () => {
  let started = 0;
  let closed = 0;
  const output: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      output.push(String(chunk));
      done();
    },
  });
  await runTerminal(
    async ({ port }) => {
      assert.equal(port, 0);
      started++;
      return {
        chat: {
          model: 'synthetic',
          maxTokens: 8,
          maxAtomic: '0',
          request: async () => new Response(),
        },
        close: async () => {
          closed++;
        },
      };
    },
    Readable.from(['/exit\n']),
    sink,
  );
  assert.equal(started, 1);
  assert.equal(closed, 1);
  assert.match(output.join(''), /synthetic/);
});

void test('main runs the terminal and closes its buyer with injected services', async () => {
  let closed = false;
  let starts = 0;
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  await main({
    input: Readable.from(['/exit\n']),
    output: sink,
    start: async () => {
      starts++;
      return {
        chat: {
          model: 'synthetic',
          maxTokens: 8,
          maxAtomic: '0',
          request: async () => new Response(),
        },
        close: async () => {
          closed = true;
        },
      };
    },
  });
  assert.equal(starts, 1);
  assert.equal(closed, true);
});

void test('terminal cancellation after a fragment aborts the request and closes once', async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let sent = 0;
  let aborted = false;
  let closed = 0;
  const output = new Writable({
    write(chunk, _encoding, done) {
      const text = String(chunk);
      if (text.includes('You: '))
        setImmediate(() => input.write('synthetic question\n'));
      if (text.includes('synthetic fragment')) controller.abort();
      done();
    },
  });
  try {
    await main({
      input,
      output,
      signal: controller.signal,
      start: async () => ({
        chat: {
          model: 'synthetic',
          maxTokens: 8,
          maxAtomic: '0',
          request: async (_url, init) => {
            sent++;
            return new Response(
              new ReadableStream({
                start(stream) {
                  init?.signal?.addEventListener(
                    'abort',
                    () => {
                      aborted = true;
                      stream.error(new Error('aborted'));
                    },
                    { once: true },
                  );
                  stream.enqueue(
                    new TextEncoder().encode(
                      'data: {"choices":[{"delta":{"content":"synthetic fragment"},"finish_reason":null}]}\n\n',
                    ),
                  );
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          },
        },
        close: async () => {
          closed++;
        },
      }),
    });
  } finally {
    input.destroy();
    output.destroy();
  }
  assert.equal(sent, 1);
  assert.equal(aborted, true);
  assert.equal(closed, 1);
});
