// Full tool loops use actual startups and native loopback in isolated children; no external tools or funds.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runToolAcceptance } from '@gyblos/lab-harness/acceptance/tools';

import { NATIVE_CAPABILITY } from '../support/native-runtime';

void test('tool acceptance refuses pre-cancellation without changing parent globals', async () => {
  const previous = globalThis.fetch;
  await assert.rejects(runToolAcceptance({ signal: AbortSignal.abort() }), {
    code: 'ACCEPTANCE_CANCELLED',
  });
  assert.equal(globalThis.fetch, previous);
});
void test(
  'native free tool acceptance traverses both client formats, terminals and refusal paths',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (context) => {
    const previous = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error('Forbidden parent fetch');
    };
    try {
      const value = await runToolAcceptance();
      assert.equal(value.ok, true);
      assert.equal(value.nativeIroh, true);
      assert.equal(value.identityEnabled, true);
      assert.equal(value.paymentsEnabled, false);
      assert.deepEqual(
        value.cases.map((item) => item.case),
        [
          'openai-json',
          'openai-stream',
          'anthropic-json',
          'anthropic-stream',
          'invalid-schema',
          'invalid-choice',
          'invalid-sequence',
          'unsupported-seller',
          'invalid-provider',
          'cut-before-terminal',
          'cancel-before-terminal',
          'automatic-refuses-tools',
        ],
      );
      for (const [index, item] of value.cases.entries())
        await context.test(item.case, () => {
          const positive = index < 4;
          const sent = positive
            ? 2
            : [
                  'invalid-provider',
                  'cut-before-terminal',
                  'cancel-before-terminal',
                ].includes(item.case)
              ? 1
              : 0;
          assert.equal(item.generations, sent);
          assert.equal(item.executionDials, sent);
          assert.equal(item.verifiedTurns, sent);
          assert.equal(item.forbiddenCalls, 0);
          if (positive) {
            assert.ok(item.queries >= 2);
            assert.ok(item.discoveryReads >= 2);
            assert.ok(item.registryReads > 0);
          }
          if (item.case === 'unsupported-seller') {
            assert.ok(item.queries > 0);
            assert.ok(item.registryReads > 0);
          }
          if (item.case === 'cancel-before-terminal')
            assert.ok(item.cancellations > 0);
        });
      assert.equal(
        /prompt|signature|nodeId|owner|address|https?:|get_time|12:00|UTC|arguments|token|\/tmp\/|\.local/i.test(
          JSON.stringify(value),
        ),
        false,
      );
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = previous;
    }
  },
);

void test('tool acceptance cancels its child without altering parent fetch', async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(runToolAcceptance({ signal: controller.signal }), {
      code: 'ACCEPTANCE_CANCELLED',
    });
    assert.equal(globalThis.fetch, previous);
  } finally {
    clearTimeout(timeout);
  }
});
