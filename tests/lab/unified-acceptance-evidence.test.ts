// Regression probes for the acceptance assertions themselves; pure synthetic wire and metadata only.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

import { BUYER_EXECUTION_FIELD, FREE_BUYER } from '@gyblos/buyer/constants';
import { MODEL } from '@gyblos/engine-ollama/model';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import { TELEMETRY_EVENTS } from '@gyblos/protocol/telemetry';

import { assertFreeAnswer } from '../support/paid-acceptance-answers';
import { PAID_ACCEPTANCE } from '../support/paid-acceptance-constants';
import { assertReceiptTelemetry } from '../support/unified-acceptance-metadata';
import { finishReceiptWait } from '../support/unified-acceptance-terminal';

function stream(lastId = 'chatcmpl-synthetic') {
  const base = {
    id: 'chatcmpl-synthetic',
    object: FREE_BUYER.chunkObject,
    created: 0,
    model: MODEL_IDS.QWEN3_0_6B,
  };
  return (
    [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: FREE_CHAT_ROLES.ASSISTANT,
              content: PAID_ACCEPTANCE.text,
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        id: lastId,
        choices: [
          { index: 0, delta: {}, finish_reason: ENGINE_DONE_REASONS.STOP },
        ],
        usage: {
          prompt_tokens: PAID_ACCEPTANCE.inputTokens,
          completion_tokens: [...PAID_ACCEPTANCE.text].length,
          total_tokens:
            PAID_ACCEPTANCE.inputTokens + [...PAID_ACCEPTANCE.text].length,
        },
        [BUYER_EXECUTION_FIELD]: OFFER_PRICING_KINDS.FREE,
      },
    ]
      .map((row) => `data: ${JSON.stringify(row)}\n\n`)
      .join('') + `data: ${FREE_BUYER.streamDone}\n\n`
  );
}
function binding() {
  return {
    requestId: '00'.repeat(16),
    buyerNodeId: '11'.repeat(32),
    sellerNodeId: '22'.repeat(32),
    selection: {
      modelId: MODEL_IDS.QWEN3_0_6B,
      variant: null,
      quantization: MODEL.quantization,
    },
    streaming: true,
  };
}
function event() {
  const expected = binding();
  return {
    ...expected,
    type: TELEMETRY_EVENTS.REQUEST_RECEIVED,
    role: P2P_ROLES.BUYER,
    engineKind: null,
    at: 0,
  };
}
void test('free acceptance requires the correct MIME type and one SSE correlation id', () => {
  assert.doesNotThrow(() =>
    assertFreeAnswer(stream(), true, FREE_BUYER.streamContentType),
  );
  assert.throws(() => assertFreeAnswer(stream(), true, 'application/json'), {
    code: 'ERR_ASSERTION',
  });
  assert.throws(
    () =>
      assertFreeAnswer(
        stream('chatcmpl-other'),
        true,
        FREE_BUYER.streamContentType,
      ),
    { code: 'ERR_ASSERTION' },
  );
});
void test('free telemetry evidence refuses unexpected fields', () => {
  assert.doesNotThrow(() =>
    assertReceiptTelemetry(event(), binding(), P2P_ROLES.BUYER),
  );
  assert.throws(
    () =>
      assertReceiptTelemetry(
        { ...event(), content: 'synthetic private content' },
        binding(),
        P2P_ROLES.BUYER,
      ),
    { code: 'ERR_ASSERTION' },
  );
});
void test('free telemetry evidence binds both peers and selection to the verified receipt', () => {
  for (const change of [
    { buyerNodeId: '33'.repeat(32) },
    { sellerNodeId: '33'.repeat(32) },
    { selection: { ...binding().selection, modelId: 'other-model' } },
    { streaming: false },
  ])
    assert.throws(
      () =>
        assertReceiptTelemetry(
          { ...event(), ...change },
          binding(),
          P2P_ROLES.BUYER,
        ),
      { code: 'ERR_ASSERTION' },
    );
});

void test('failed receipt wait releases a pending readline question and preserves its cause', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input, output });
  const controller = new AbortController();
  const cause = new Error('Synthetic receipt confirmation failure');
  let released = false;
  const question = reader.question('You: ', { signal: controller.signal }).then(
    () => {
      released = true;
    },
    () => {
      released = true;
    },
  );
  try {
    const outcome = await finishReceiptWait(
      input,
      controller,
      Promise.reject(cause),
    );
    assert.deepEqual(outcome, { ok: false, error: cause });
    await tick();
    assert.equal(released, true);
  } finally {
    controller.abort();
    await question;
    reader.close();
    input.destroy();
    output.destroy();
  }
});
