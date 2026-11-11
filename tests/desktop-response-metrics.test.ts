// Descriptive telemetry uses synthetic responses, never payment authority.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseChatArchive,
  projectChatArchive,
  restoreChatArchive,
} from '@gyblos/desktop/chat-archive-model';
import { ChatController } from '@gyblos/desktop/chat-controller';
import {
  generationSpeed,
  observedResponse,
  parseResponseMetrics,
  reportedUsage,
} from '@gyblos/desktop/response-metrics';

import { conversation, model } from './support/chat-archive-fixture';

const metrics = {
  inputTokens: 12,
  outputTokens: 8,
  firstTokenMs: null,
  generationMs: null,
  responseMs: 1234,
  cost: { amount: '0.10', unit: 'USD', kind: 'recorded' },
};
void test('buffered response time never masquerades as first-token latency or generation throughput', () => {
  const observation = observedResponse(
    1234,
    { amount: '0.10', unit: 'USD', kind: 'recorded' },
    reportedUsage(
      { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      128,
    ),
  );
  assert.deepEqual(observation, metrics);
  assert.equal(generationSpeed(observation), null);
  assert.equal(generationSpeed({ ...observation, generationMs: 200 }), 40);
  assert.equal(generationSpeed({ ...observation, generationMs: 0 }), null);
  assert.equal(
    observedResponse(-1, { amount: '0', unit: 'atomic units', kind: 'settled' })
      .responseMs,
    null,
  );
});
void test('unknown, zero and malformed metrics remain distinct at the boundary', () => {
  assert.equal(parseResponseMetrics(undefined), null);
  assert.deepEqual(
    reportedUsage({ prompt_tokens: 0, completion_tokens: 0 }, 128),
    { inputTokens: 0, outputTokens: 0 },
  );
  assert.ok(
    parseResponseMetrics({
      ...metrics,
      inputTokens: 0,
      outputTokens: 0,
      responseMs: 0,
    }),
  );
  for (const invalid of [
    { ...metrics, cost: { ...metrics.cost, amount: 'NaN' } },
    { ...metrics, cost: { ...metrics.cost, amount: '0.001' } },
    { ...metrics, responseMs: Infinity },
  ])
    assert.equal(parseResponseMetrics(invalid), null);
});
void test('response metadata survives a local archive without resuming work or conferring payment authority', () => {
  const archive = projectChatArchive(conversation().getSnapshot())!;
  const first = archive.sessions[0]!;
  const parsed = parseChatArchive({
    ...archive,
    sessions: [
      {
        ...first,
        messages: first.messages.map((message) =>
          message.role === 'assistant' ? { ...message, metrics } : message,
        ),
      },
    ],
  });
  assert.ok(parsed);
  const restored = restoreChatArchive(parsed);
  assert.deepEqual(restored.sessions[0]?.messages[1]?.metrics, metrics);
  assert.equal(restored.sessions[0]?.paypalRun, null);
  assert.ok(parseChatArchive(archive), 'legacy messages remain readable');
});
void test('archives reject malformed telemetry and telemetry attached to user messages', () => {
  const archive = projectChatArchive(conversation().getSnapshot())!;
  const first = archive.sessions[0]!;
  for (const invalid of [
    null,
    { ...metrics, responseMs: -1 },
    { ...metrics, inputTokens: Number.MAX_SAFE_INTEGER },
    { ...metrics, cost: { ...metrics.cost, unit: 'unknown' } },
    { ...metrics, secret: 'unexpected' },
  ]) {
    assert.equal(
      parseChatArchive({
        ...archive,
        sessions: [
          { ...first, messages: [{ ...first.messages[1], metrics: invalid }] },
        ],
      }),
      null,
    );
  }
  assert.equal(
    parseChatArchive({
      ...archive,
      sessions: [{ ...first, messages: [{ ...first.messages[0], metrics }] }],
    }),
    null,
  );
});
void test('only the matching live response receives metrics and stale completions cannot replace them', () => {
  const chat = new ChatController('one');
  chat.startPaypal('Synthetic question', model, 'request');
  chat.newChat('two');
  chat.completePaypal('two', 'request', 'Wrong conversation', model, metrics);
  chat.completePaypal('one', 'other', 'Wrong request', model, metrics);
  chat.completePaypal('one', 'request', 'Answer', model, metrics);
  chat.completePaypal('one', 'request', 'Duplicate', model, {
    ...metrics,
    outputTokens: 99,
  });
  const answer = chat.getSnapshot().sessions[0]?.messages[1];
  assert.equal(answer?.text, 'Answer');
  assert.deepEqual(answer?.metrics, metrics);
  assert.equal(chat.getSnapshot().sessions[1]?.messages.length, 0);
});
