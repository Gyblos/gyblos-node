// Synthetic terminal boundary for the real buyer CLI; no wallet, RPC or external services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

void test(
  'SIGINT during terminal streaming aborts once and closes the buyer',
  { timeout: 15000 },
  async () => {
    const source = `
    import { main } from '@gyblos/buyer/chat-cli';
    let calls = 0, closed = 0, aborted = 0;
    await main({ input: process.stdin, output: process.stdout, start: async () => ({
      chat: { model: 'synthetic', maxTokens: 8, maxAtomic: '0', request: async (_url, init) => {
        calls++;
        return new Response(new ReadableStream({ start(stream) {
          init.signal.addEventListener('abort', () => { aborted++; stream.error(new Error('stopped')); }, { once: true });
          stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"synthetic fragment"},"finish_reason":null}]}\\n\\n'));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      } }, close: async () => { closed++; },
    }) });
    process.stdout.write('\\nCOUNTS:' + JSON.stringify({ calls, aborted, closed }) + '\\n');
  `;
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '-e',
        source,
      ],
      {
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let sent = false;
    let signalled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!sent && output.includes('You: ')) {
        sent = true;
        child.stdin.write('synthetic question\n');
      }
      if (!signalled && output.includes('synthetic fragment')) {
        signalled = true;
        child.kill('SIGINT');
      }
    });
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(exit, 0, errors);
      assert.equal(signalled, true);
      assert.match(output, /COUNTS:\{"calls":1,"aborted":1,"closed":1\}/);
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
    }
  },
);
