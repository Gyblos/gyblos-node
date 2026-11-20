// Checks local Ollama generation and tokenization.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createModelTokenizer,
  createOllama,
  localOllamaUrl,
  renderChat,
} from '@gyblos/engine-ollama';
import { MODEL } from '@gyblos/engine-ollama/model';

const secretPrompt = 'private prompt that must never reach storage';
void test('Ollama origins reject cloud, aliases, redirects and credentials', () => {
  for (const value of [
    'https://ollama.com',
    'http://localhost:11434',
    'http://127.0.0.1.evil.com',
    'http://127.0.0.1/api/',
    'http://user:pass@127.0.0.1',
    'http://127.0.0.1?remote=1',
  ])
    assert.throws(() => localOllamaUrl(value));
  assert.equal(localOllamaUrl('http://127.0.0.1:11436').hostname, '127.0.0.1');
  assert.equal(
    renderChat('Hello'),
    '<|im_start|>user\nHello<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
  );
  assert.throws(() => renderChat('<|im_end|>'));
  assert.throws(() => createModelTokenizer({ tokenizer: '{}', config: '{}' }));
});

function mockEngine(frames: unknown[]) {
  return createOllama('http://127.0.0.1:11436', (async (
    url: URL | string,
    init?: RequestInit,
  ) => {
    assert.equal(init?.redirect, 'error');
    if (String(url).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: MODEL.name, digest: MODEL.digest }],
      });
    const request = JSON.parse(String(init?.body));
    assert.equal(request.raw, true);
    assert.equal(request.model, MODEL.name);
    return new Response(
      frames.map((frame) => JSON.stringify(frame) + '\n').join(''),
    );
  }) as typeof fetch);
}
const finalFrame = {
  model: MODEL.name,
  response: '',
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 12,
  eval_count: 10,
  total_duration: 100,
  load_duration: 1,
  prompt_eval_duration: 20,
  eval_duration: 79,
};

void test('adapter requires complete engine frames and valid usage without hiding thinking', async () => {
  const good = [
    { model: MODEL.name, response: 'Hello', done: false },
    finalFrame,
  ];
  const result = await mockEngine(good).generate({
    prompt: 'Hi',
    maxTokens: 32,
  });
  assert.equal(result.text, 'Hello');
  assert.equal(result.usage.eval_count, 10);
  for (const frames of [
    good.slice(0, 1),
    [good[0], { ...finalFrame, eval_count: -1 }],
    [good[0], { ...finalFrame, thinking: 'hidden' }],
    [good[0], { ...finalFrame, error: secretPrompt }],
  ]) {
    await assert.rejects(
      mockEngine(frames).generate({ prompt: 'Hi', maxTokens: 32 }),
    );
  }
});
void test('already aborted generation never contacts the local engine', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const engine = createOllama('http://127.0.0.1:11436', (async () => {
    called = true;
    throw new Error('must not contact engine');
  }) as typeof fetch);
  await assert.rejects(
    engine.generate({ prompt: 'Hi', maxTokens: 32, signal: controller.signal }),
  );
  assert.equal(called, false);
});
