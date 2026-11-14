// Buyer checkpoint validation never accepts two unacknowledged blocks or changes a cumulative bill.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BatchChannelError } from '@gyblos/protocol/batch-channel';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  createSessionBlockVerifier,
  SESSION_BLOCK_KINDS,
} from '@gyblos/protocol/session-blocks';

import { binding, block } from './support/session-blocks';

function verifier() {
  return createSessionBlockVerifier({
    binding,
    request: block.bill,
    baseAtomic: '5',
    depositAtomic: '25',
    maxTokens: 10,
    verify: async (text) => ({
      inputTokens: 2,
      outputTokens: text.length,
      chargedAtomic: String(2 + text.length),
    }),
  });
}
function ack(digest: string, index = 0, total = '8') {
  return {
    ...binding,
    index,
    kind: SESSION_BLOCK_KINDS.ACK,
    blockDigest: digest,
    cumulativeAtomic: total,
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof BatchChannelError && error.code === expected;

void test('a checkpoint must be durably acknowledged before another block is accepted', async () => {
  const v = verifier();
  const first = await v.accept(block);
  await assert.rejects(v.accept(block), code(SESSION_CODES.BUSY));
  v.acknowledge(ack(first.digest));
  const last = {
    ...block,
    index: 1,
    text: 'b',
    usage: { inputTokens: 2, outputTokens: 2 },
    bill: { ...block.bill, chargedAtomic: '4', cumulativeAtomic: '9' },
    terminal: {
      text: 'ab',
      usage: { inputTokens: 2, outputTokens: 2 },
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
  };
  const second = await v.accept(last);
  v.acknowledge(ack(second.digest, 1, '9'));
  v.finish();
  await assert.rejects(v.accept(last), code(SESSION_CODES.BUSY));
});
for (const [name, change] of [
  ['channel', { channelId: '11111111111111111111111111111112' }],
  ['request', { requestId: '33'.repeat(16) }],
  ['digest', { requestDigest: '33'.repeat(32) }],
  ['index', { index: 1 }],
  ['usage', { usage: { inputTokens: 2, outputTokens: 2 } }],
  ['charge', { bill: { ...block.bill, chargedAtomic: '4' } }],
  ['prior total', { bill: { ...block.bill, cumulativeAtomic: '9' } }],
  ['request ceiling', { bill: { ...block.bill, maxAtomic: '21' } }],
] satisfies Array<[string, object]>) {
  void test(`checkpoint rejects changed ${name} before approval`, async () => {
    const v = verifier();
    await assert.rejects(
      v.accept({ ...block, ...change }),
      code(SESSION_CODES.BINDING),
    );
    await assert.rejects(v.accept(block), code(SESSION_CODES.BUSY));
  });
}
for (const [name, change] of [
  ['digest', { blockDigest: '33'.repeat(32) }],
  ['total', { cumulativeAtomic: '9' }],
  ['index', { index: 1 }],
] satisfies Array<[string, object]>) {
  void test(`ACK rejects changed ${name} without releasing the checkpoint`, async () => {
    const v = verifier();
    const accepted = await v.accept(block);
    assert.throws(
      () => v.acknowledge({ ...ack(accepted.digest), ...change }),
      code(SESSION_CODES.BINDING),
    );
    assert.throws(() => v.finish(), code(SESSION_CODES.INVALID));
  });
}
void test('a failing independent recount prevents all later approvals', async () => {
  const v = createSessionBlockVerifier({
    binding,
    request: block.bill,
    baseAtomic: '5',
    depositAtomic: '25',
    maxTokens: 10,
    verify: async () => {
      throw new Error('synthetic failure');
    },
  });
  await assert.rejects(v.accept(block), code(PAID_EXECUTION_CODES.INTERNAL));
  await assert.rejects(v.accept(block), code(SESSION_CODES.BUSY));
});

void test('EOF before an ACK permanently rejects the unfinished transcript', async () => {
  const v = verifier();
  const accepted = await v.accept(block);
  assert.throws(() => v.finish(), code(SESSION_CODES.INVALID));
  assert.throws(
    () => v.acknowledge(ack(accepted.digest)),
    code(SESSION_CODES.INVALID),
  );
});

void test('combined block output keeps the existing aggregate text bound', async () => {
  let count = 0;
  const v = createSessionBlockVerifier({
    binding,
    request: block.bill,
    baseAtomic: '5',
    depositAtomic: '25',
    maxTokens: 10,
    verify: async () => ({
      inputTokens: 2,
      outputTokens: ++count,
      chargedAtomic: String(2 + count),
    }),
  });
  const first = await v.accept({ ...block, text: 'a'.repeat(262144) });
  v.acknowledge(ack(first.digest));
  await assert.rejects(
    v.accept({
      ...block,
      index: 1,
      text: 'b',
      usage: { inputTokens: 2, outputTokens: 2 },
      bill: { ...block.bill, chargedAtomic: '4', cumulativeAtomic: '9' },
    }),
    code(SESSION_CODES.LIMIT),
  );
});

for (const interrupted of ['EOF', 'invalid ACK']) {
  void test(`a pending recount cannot return an approval after ${interrupted}`, async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const v = createSessionBlockVerifier({
      binding,
      request: block.bill,
      baseAtomic: '5',
      depositAtomic: '25',
      maxTokens: 10,
      verify: async () => {
        await paused;
        return { inputTokens: 2, outputTokens: 1, chargedAtomic: '3' };
      },
    });
    const accepting = v.accept(block);
    if (interrupted === 'EOF')
      assert.throws(() => v.finish(), code(SESSION_CODES.INVALID));
    else
      assert.throws(
        () => v.acknowledge(ack('33'.repeat(32))),
        code(SESSION_CODES.INVALID),
      );
    release();
    await assert.rejects(accepting, code(SESSION_CODES.INVALID));
    await assert.rejects(v.accept(block), code(SESSION_CODES.BUSY));
  });
}

for (const scenario of [
  {
    name: 'deposit',
    deposit: '8',
    maxTokens: 10,
    input: 2,
    output: 2,
    amount: '4',
    expected: SESSION_CODES.LIMIT,
  },
  {
    name: 'decreasing charge',
    deposit: '25',
    maxTokens: 10,
    input: 2,
    output: 2,
    amount: '2',
    expected: SESSION_CODES.LIMIT,
  },
  {
    name: 'decreasing output',
    deposit: '25',
    maxTokens: 10,
    input: 2,
    output: 0,
    amount: '4',
    expected: SESSION_CODES.LIMIT,
  },
  {
    name: 'request output ceiling',
    deposit: '25',
    maxTokens: 1,
    input: 2,
    output: 2,
    amount: '4',
    expected: SESSION_CODES.LIMIT,
  },
  {
    name: 'changed input',
    deposit: '25',
    maxTokens: 10,
    input: 3,
    output: 2,
    amount: '4',
    expected: SESSION_CODES.BINDING,
  },
]) {
  void test(`second checkpoint rejects ${scenario.name} even if its recount agrees`, async () => {
    let calls = 0;
    const v = createSessionBlockVerifier({
      binding,
      request: block.bill,
      baseAtomic: '5',
      depositAtomic: scenario.deposit,
      maxTokens: scenario.maxTokens,
      verify: async () =>
        ++calls === 1
          ? { inputTokens: 2, outputTokens: 1, chargedAtomic: '3' }
          : {
              inputTokens: scenario.input,
              outputTokens: scenario.output,
              chargedAtomic: scenario.amount,
            },
    });
    const first = await v.accept(block);
    v.acknowledge(ack(first.digest));
    const usage = {
      inputTokens: scenario.input,
      outputTokens: scenario.output,
    };
    await assert.rejects(
      v.accept({
        ...block,
        index: 1,
        text: 'b',
        usage,
        bill: {
          ...block.bill,
          chargedAtomic: scenario.amount,
          cumulativeAtomic: String(5 + Number(scenario.amount)),
        },
        terminal: { text: 'ab', usage, finishReason: ENGINE_DONE_REASONS.STOP },
      }),
      code(scenario.expected),
    );
  });
}
