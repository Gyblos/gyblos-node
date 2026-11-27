import assert from 'node:assert/strict';
import test from 'node:test';

void test('the OpenCode driver can be imported without a binary or startup side effects', async () => {
  await import('./opencode-interruption');
});

void test('the signed prefix remains the only output until the downstream cut', async () => {
  const { interruptedGeneration } =
    await import('../support/opencode-interruption');
  const cut = new AbortController();
  const fragments: string[] = [];
  let done = false;
  const work = interruptedGeneration(async (text: string) => {
    fragments.push(text);
  }, cut.signal).finally(() => {
    done = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(fragments.length, 1);
  cut.abort();
  await assert.rejects(work);
  assert.equal(fragments.length, 1);
});

void test('the proxy distinguishes upstream and streaming failures from the intentional cut', async (t) => {
  const { interruptionProxy } =
    await import('../support/opencode-interruption');
  const phases: string[] = [];
  let step = 0;
  let cutCount = 0;
  const server = interruptionProxy({
    upstream: async () => {
      if (++step === 1) throw new Error('private synthetic canary');
      if (step === 2)
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error('private synthetic canary'));
            },
          }),
        );
      return new Response('prefix');
    },
    headers: async () => {},
    cut: async () => true,
    disconnected: () => {
      cutCount++;
    },
    failure: (stage) => phases.push(stage),
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  for (let turn = 0; turn < 3; turn++)
    await fetch('http://127.0.0.1:' + addr.port + '/v1/chat/completions', {
      method: 'POST',
    })
      .then((res) => res.text())
      .catch(() => undefined);
  assert.deepEqual(phases, ['upstream', 'stream']);
  assert.equal(cutCount, 1);
});
