// Preview reasoning choices follow the shared catalog; they never enable a payment or live route.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseChatArchive,
  projectChatArchive,
  restoreChatArchive,
} from '@gyblos/desktop/chat-archive-model';
import { ChatController } from '@gyblos/desktop/chat-controller';
import {
  chatReasoningChoice,
  reasoningLabel,
} from '@gyblos/desktop/chat-reasoning';
import { DEMO_AUTH } from '@gyblos/desktop/demo-account';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';
import { MODEL_IDS, REASONING_LEVELS } from '@gyblos/protocol/constants';

const qwen = {
  id: 'qwen',
  catalogId: MODEL_IDS.QWEN3_30B_A3B,
  name: 'Synthetic Qwen',
  free: true,
  image: { src: '/synthetic.svg' },
};
const oss = { ...qwen, id: 'oss', catalogId: MODEL_IDS.GPT_OSS_20B };

void test('preview reasoning uses binary and graded catalog capabilities and their defaults', () => {
  const binary = chatReasoningChoice(qwen, PAYMENT_METHOD.USDC, null)!;
  const graded = chatReasoningChoice(oss, PAYMENT_METHOD.USDC, null)!;
  assert.deepEqual(binary.support.levels, [
    REASONING_LEVELS.OFF,
    REASONING_LEVELS.HIGH,
  ]);
  assert.equal(binary.value, REASONING_LEVELS.OFF);
  assert.equal(reasoningLabel(binary.support, REASONING_LEVELS.HIGH), 'On');
  assert.deepEqual(graded.support.levels, [
    REASONING_LEVELS.LOW,
    REASONING_LEVELS.MEDIUM,
    REASONING_LEVELS.HIGH,
  ]);
  assert.equal(graded.value, REASONING_LEVELS.LOW);
});
void test('reasoning hides unknown, non-thinking and live PayPal models', () => {
  for (const model of [
    { ...qwen, catalogId: undefined },
    { ...qwen, catalogId: MODEL_IDS.LLAMA_3_3_70B },
    { ...qwen, catalogId: MODEL_IDS.DEEPSEEK_V4_1_FLASH },
  ])
    assert.equal(chatReasoningChoice(model, PAYMENT_METHOD.USDC, null), null);
  assert.equal(chatReasoningChoice(qwen, PAYMENT_METHOD.PAYPAL, null), null);
});
void test('a model change cannot carry an unsupported reasoning level into the next model', () => {
  assert.equal(
    chatReasoningChoice(qwen, PAYMENT_METHOD.USDC, {
      modelId: qwen.id,
      level: REASONING_LEVELS.MEDIUM,
    })?.value,
    REASONING_LEVELS.OFF,
  );
  assert.equal(
    chatReasoningChoice(oss, PAYMENT_METHOD.USDC, {
      modelId: qwen.id,
      level: REASONING_LEVELS.HIGH,
    })?.value,
    REASONING_LEVELS.LOW,
  );
  assert.equal(
    chatReasoningChoice(oss, PAYMENT_METHOD.USDC, {
      modelId: oss.id,
      level: REASONING_LEVELS.HIGH,
    })?.value,
    REASONING_LEVELS.HIGH,
  );
});
void test('the preview captures its chosen reasoning level in the run and private display history', () => {
  const chat = new ChatController('conversation');
  assert.ok(
    chat.start(
      'Synthetic question',
      oss,
      [],
      'run',
      () => DEMO_AUTH.APPROVED,
      REASONING_LEVELS.HIGH,
    ),
  );
  const answer = chat.getSnapshot().sessions[0]!.messages.at(-1)!;
  assert.equal(answer.reasoning, REASONING_LEVELS.HIGH);
  const archive = projectChatArchive(chat.getSnapshot());
  assert.ok(archive);
  assert.equal(
    restoreChatArchive(archive).sessions[0]!.messages.at(-1)?.reasoning,
    REASONING_LEVELS.HIGH,
  );
  assert.equal(restoreChatArchive(archive).sessions[0]!.run, null);
});
void test('saved reasoning rejects unknown values and cannot become a live PayPal setting', () => {
  const chat = new ChatController('conversation');
  chat.start(
    'Synthetic question',
    oss,
    [],
    'run',
    () => DEMO_AUTH.APPROVED,
    REASONING_LEVELS.HIGH,
  );
  const archive = projectChatArchive(chat.getSnapshot())!;
  const conversation = archive.sessions[0]!;
  const message = conversation.messages[0]!;
  for (const change of [
    { reasoning: 'extreme' },
    { paymentMethod: PAYMENT_METHOD.PAYPAL },
  ])
    assert.equal(
      parseChatArchive({
        ...archive,
        sessions: [{ ...conversation, messages: [{ ...message, ...change }] }],
      }),
      null,
    );
});
