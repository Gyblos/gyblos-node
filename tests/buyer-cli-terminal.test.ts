// Synthetic terminal boundary for the real buyer CLI; no wallet, RPC or external services.
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { runTerminal } from '@gyblos/buyer/chat-cli';

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
