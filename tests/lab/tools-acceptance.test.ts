// Full tool loops use actual startups and native loopback in isolated children; no external tools or funds.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runToolAcceptance } from '@gyblos/lab-harness/acceptance/tools';

import { NATIVE_CAPABILITY } from '../support/native-runtime';

void test('tool acceptance refuses pre-cancellation without changing parent globals', async () => {
  const previous = globalThis.fetch;
  await assert.rejects(runToolAcceptance({ signal: AbortSignal.abort() }), { code: 'ACCEPTANCE_CANCELLED' });
  assert.equal(globalThis.fetch, previous);
});
void test('native free tool acceptance traverses both client formats, terminals and refusal paths',
  { skip: NATIVE_CAPABILITY.transportSkip }, async () => {
    const previous = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Forbidden parent fetch'); };
    try {
      const value = await runToolAcceptance();
      assert.ok(value);
      assert.equal(calls, 0);
    } finally { globalThis.fetch = previous; }
  });
