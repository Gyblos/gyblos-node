// Failover "safe": a free request whose seller failed after the prompt was sent, but before any visible
// text reached the client, goes to another seller, at most twice. Visible text, a refusal of the request
// itself, a client that left or failover "never" end the request instead. Injected selection and
// execution, a real signed quote; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { FreeBuyerError } from '@gyblos/buyer/free-chat';
import {
  executeBuyerFree,
  type FreeBuyerDependencies,
} from '@gyblos/buyer/free-execution';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION_CODES,
  type FreeExecutionCode,
} from '@gyblos/protocol/constants';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { selectionFixture } from './support/buyer-selection';
import { freeSellerFixture } from './support/free-seller';

const QUOTE = (await (await freeSellerFixture()).request()).quote;
const INPUT = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 5,
};
const answer = (nodeId: string) => ({
  text: `from ${nodeId}`,
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: ENGINE_DONE_REASONS.STOP,
});
// What a seller does once it has the prompt: text before failing, then the failure.
interface Fault {
  text?: string[];
  error: FreeClientError;
}
const sent = (
  code: FreeExecutionCode,
  options: { io?: boolean; consumer?: boolean } = {},
) => new FreeClientError(code, true, false, {}, options.io, options.consumer);

function rig(
  faults: Record<string, Fault>,
  resend: 'on' | 'off' | 'unset' = 'on',
) {
  const sellers = ['a', 'b', 'c', 'd'];
  const asked: string[] = [];
  const dependencies: FreeBuyerDependencies = {
    ...(resend === 'unset' ? {} : { resendAfterSend: resend === 'on' }),
    select: async (excluded) => {
      const next = sellers.find((nodeId) => !excluded.has(nodeId));
      if (!next) throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      return { nodeId: next, quote: QUOTE };
    },
    execute: async (winner, _request, _signal, onDelta) => {
      asked.push(winner.nodeId);
      const fault = faults[winner.nodeId];
      if (!fault) return answer(winner.nodeId);
      for (const text of fault.text ?? []) await onDelta?.(text);
      throw fault.error;
    },
  };
  return { dependencies, asked };
}
const stream = async () => {};

for (const [name, error] of [
  ['the connection dropped', sent(FREE_EXECUTION_CODES.INTERNAL, { io: true })],
  ['it timed out', sent(FREE_EXECUTION_CODES.TIMEOUT)],
  ['its engine stopped', sent(FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE)],
] as const)
  void test(`a seller that got the prompt and failed before any text is replaced: ${name}`, async () => {
    for (const onDelta of [undefined, stream]) {
      const { dependencies, asked } = rig({ a: { error } });
      const result = await executeBuyerFree(
        INPUT,
        dependencies,
        undefined,
        onDelta,
      );
      assert.equal(result.text, 'from b');
      assert.deepEqual(asked, ['a', 'b']);
    }
  });

void test('empty deltas are not visible text, so the request still moves', async () => {
  const { dependencies, asked } = rig({
    a: { text: ['', ''], error: sent(FREE_EXECUTION_CODES.TIMEOUT) },
  });
  const result = await executeBuyerFree(INPUT, dependencies, undefined, stream);
  assert.equal(result.text, 'from b');
  assert.deepEqual(asked, ['a', 'b']);
});

void test('once text reached the client, the failure ends the request', async () => {
  const { dependencies, asked } = rig({
    a: { text: ['Hel'], error: sent(FREE_EXECUTION_CODES.TIMEOUT) },
  });
  await assert.rejects(
    executeBuyerFree(INPUT, dependencies, undefined, stream),
    { code: FREE_EXECUTION_CODES.TIMEOUT },
  );
  assert.deepEqual(asked, ['a']);
});

for (const [name, error] of [
  ['the prompt is too long', sent(FREE_EXECUTION_CODES.LIMIT)],
  ['the request is unsupported', sent(FREE_EXECUTION_CODES.UNSUPPORTED)],
  [
    'the client left',
    sent(FREE_EXECUTION_CODES.INTERNAL, { io: true, consumer: true }),
  ],
] as const)
  void test(`a failure another seller cannot fix is not resent: ${name}`, async () => {
    const { dependencies, asked } = rig({ a: { error } });
    await assert.rejects(executeBuyerFree(INPUT, dependencies));
    assert.deepEqual(asked, ['a']);
  });

void test('failover "never" (or a caller that does not opt in) keeps the prompt on one seller', async () => {
  for (const resend of ['off', 'unset'] as const) {
    const { dependencies, asked } = rig(
      { a: { error: sent(FREE_EXECUTION_CODES.TIMEOUT) } },
      resend,
    );
    await assert.rejects(executeBuyerFree(INPUT, dependencies), {
      code: FREE_EXECUTION_CODES.TIMEOUT,
    });
    assert.deepEqual(asked, ['a']);
  }
});

void test('a prompt goes to at most three sellers', async () => {
  const error = sent(FREE_EXECUTION_CODES.TIMEOUT);
  const { dependencies, asked } = rig({
    a: { error },
    b: { error },
    c: { error },
  });
  await assert.rejects(executeBuyerFree(INPUT, dependencies), {
    code: FREE_EXECUTION_CODES.TIMEOUT,
  });
  assert.deepEqual(asked, ['a', 'b', 'c']);
});

void test('selection.json takes failover "safe" or "never" only', async () => {
  const run = await selectionFixture();
  try {
    const base = JSON.parse(JSON.stringify(run.config)) as Record<
      string,
      unknown
    >;
    assert.equal(parseBuyerSelectionConfig(base).failover, undefined);
    for (const failover of ['safe', 'never'] as const)
      assert.equal(
        parseBuyerSelectionConfig({ ...base, failover }).failover,
        failover,
      );
    for (const failover of ['always', true, null, 1])
      assert.throws(() => parseBuyerSelectionConfig({ ...base, failover }), {
        code: 'INVALID_BUYER_SELECTION_CONFIG',
      });
  } finally {
    await run.wire.close();
  }
});

void test('with no other seller to take it, the client sees the seller failure', async () => {
  const error = sent(FREE_EXECUTION_CODES.TIMEOUT);
  const { dependencies, asked } = rig({
    a: { error },
    b: { error },
    c: { error },
    d: { error },
  });
  // Only seller a exists: selection then finds no one.
  const only: FreeBuyerDependencies = {
    ...dependencies,
    select: async (excluded, signal, needs) => {
      if (excluded.has('a'))
        throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      return dependencies.select(excluded, signal, needs);
    },
  };
  await assert.rejects(executeBuyerFree(INPUT, only), {
    code: FREE_EXECUTION_CODES.TIMEOUT,
  });
  assert.deepEqual(asked, ['a']);
});
