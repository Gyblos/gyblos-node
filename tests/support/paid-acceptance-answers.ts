// Checks exact synthetic buyer delivery independently of payment certainty; not a product response parser.
import assert from 'node:assert/strict';

import {
  FREE_BUYER,
  PAID_BUYER,
  PAID_VERDICTS,
  type PaidVerdict,
} from '@gyblos/buyer/constants';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  MODEL_IDS,
} from '@gyblos/protocol/constants';
import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';

function usage(value: unknown) {
  assert.deepEqual(
    controlObject(value, [
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
    ]),
    {
      prompt_tokens: PAID_ACCEPTANCE.inputTokens,
      completion_tokens: [...PAID_ACCEPTANCE.text].length,
      total_tokens:
        PAID_ACCEPTANCE.inputTokens + [...PAID_ACCEPTANCE.text].length,
    },
  );
}
function payment(value: unknown, verdict: PaidVerdict) {
  const row = controlObject(value, [
    'verdict',
    'maxAtomic',
    'expectedAtomic',
    'chargedAtomic',
    'sellerAtomic',
    'feeAtomic',
    'refundedAtomic',
    'recorded',
  ]);
  assert.equal(row.verdict, verdict);
  assert.equal(row.maxAtomic, PAID_ACCEPTANCE.maxAtomic);
  assert.equal(row.recorded, verdict !== PAID_VERDICTS.SETTLED);
}
export function assertPaidJsonAnswer(body: string, verdict: PaidVerdict) {
  const row = controlObject(JSON.parse(body), [
    'id',
    'object',
    'created',
    'model',
    'choices',
    'usage',
    PAID_BUYER.paymentField,
  ]);
  assert.equal(row.object, FREE_BUYER.completionObject);
  assert.equal(row.model, MODEL_IDS.QWEN3_0_6B);
  const choices = controlArray(row.choices, 1);
  assert.equal(choices.length, 1);
  const choice = controlObject(choices[0], [
    'index',
    'message',
    'finish_reason',
  ]);
  assert.equal(choice.index, 0);
  assert.equal(choice.finish_reason, ENGINE_DONE_REASONS.STOP);
  const message = controlObject(choice.message, ['role', 'content']);
  assert.equal(message.role, FREE_CHAT_ROLES.ASSISTANT);
  assert.equal(message.content, PAID_ACCEPTANCE.text);
  usage(row.usage);
  payment(row[PAID_BUYER.paymentField], verdict);
}
export function assertPaidStreamAnswer(
  body: string,
  contentType: string | undefined,
) {
  assert.equal(contentType, FREE_BUYER.streamContentType);
  const frames = body.trimEnd().split('\n\n');
  assert.equal(frames.pop(), `data: ${FREE_BUYER.streamDone}`);
  let text = '';
  let id: string | undefined;
  let ended = false;
  for (const frame of frames) {
    assert.equal(ended, false);
    assert.ok(frame.startsWith('data: '));
    const value: unknown = JSON.parse(frame.slice('data: '.length));
    const has = (key: string) =>
      typeof value === 'object' && value !== null && Object.hasOwn(value, key);
    const row = controlObject(value, [
      'id',
      'object',
      'created',
      'model',
      'choices',
      ...(has('usage') ? ['usage'] : []),
      ...(has(PAID_BUYER.paymentField) ? [PAID_BUYER.paymentField] : []),
    ]);
    assert.equal(row.object, FREE_BUYER.chunkObject);
    assert.equal(row.model, MODEL_IDS.QWEN3_0_6B);
    assert.ok(typeof row.id === 'string');
    id ??= row.id;
    assert.equal(row.id, id);
    const choices = controlArray(row.choices, 1);
    assert.equal(choices.length, 1);
    const choice = controlObject(choices[0], [
      'index',
      'delta',
      'finish_reason',
    ]);
    assert.equal(choice.index, 0);
    if (choice.finish_reason === ENGINE_DONE_REASONS.STOP) {
      controlObject(choice.delta, []);
      usage(row.usage);
      payment(row[PAID_BUYER.paymentField], PAID_VERDICTS.SETTLED);
      ended = true;
    } else {
      assert.equal(choice.finish_reason, null);
      assert.equal(has('usage') || has(PAID_BUYER.paymentField), false);
      const withRole =
        typeof choice.delta === 'object' &&
        choice.delta !== null &&
        Object.hasOwn(choice.delta, 'role');
      const delta = controlObject(choice.delta, [
        'content',
        ...(withRole ? ['role'] : []),
      ]);
      if (withRole) assert.equal(delta.role, FREE_CHAT_ROLES.ASSISTANT);
      assert.ok(typeof delta.content === 'string');
      text += delta.content;
    }
  }
  assert.equal(ended, true);
  assert.equal(text, PAID_ACCEPTANCE.text);
}
