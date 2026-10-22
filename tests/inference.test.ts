import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { CHARGE_ANOMALIES } from '@gyblos/application/constants';

import { transactionTransfers } from '../lab/harness/scripts/inference-chain.js';
import {
  appendMeasurement,
  measurementRow,
  measurementSalt,
} from '../lab/harness/scripts/measurements.js';
import {
  assessCharge,
  charge,
  compareUsage,
  tokenAllowance,
} from '../packages/application/src/metering.js';
import {
  createModelTokenizer,
  createOllama,
  localOllamaUrl,
  MODEL,
  renderChat,
} from '../packages/inference-ollama/src/index.js';

const secretPrompt = 'private prompt that must never reach storage';
const secretResponse = 'private response that must never reach storage';

test('integer token pricing, tolerance boundaries and within-ceiling overcharge', () => {
  assert.equal(charge({ input: 23, output: 57 }), 137n);
  for (const invalid of [-1, 0.1, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => charge({ input: invalid, output: 0 }));
  assert.equal(tokenAllowance(10), 2);
  assert.equal(tokenAllowance(1000), 20);
  assert.equal(
    compareUsage({ input: 12, output: 1020 }, { input: 10, output: 1000 })
      .withinTolerance,
    true,
  );
  assert.equal(
    compareUsage({ input: 13, output: 1021 }, { input: 10, output: 1000 })
      .withinTolerance,
    false,
  );
  const honest = { input: 20, output: 60 };
  const paid = charge({ input: 20, output: 84 });
  assert.ok(paid < 512n);
  assert.equal(assessCharge(paid, honest, true, false).anomaly, 'overcharge');
  assert.equal(
    assessCharge(charge(honest), honest, true, false).anomaly,
    'none',
  );
  assert.equal(assessCharge(0n, honest, false, true).expectedAtomic, '0');
  assert.equal(assessCharge(1n, honest, false, true).anomaly, 'overcharge');
  assert.equal(assessCharge(0n, honest, false, true).anomaly, 'failed');
  assert.equal(
    assessCharge(charge(honest), honest, false, false).anomaly,
    'incomplete',
  );
});

test('Ollama origins reject cloud, aliases, redirects and credentials', () => {
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

test('adapter requires complete engine frames and valid usage without hiding thinking', async () => {
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

test('private measurement rows use an allowlist and append without rewriting old rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-meter-'));
  try {
    const salt = await measurementSalt(directory);
    assert.deepEqual(await measurementSalt(directory), salt);
    const path = join(directory, 'measurements.jsonl');
    for (const anomaly of [
      CHARGE_ANOMALIES.NONE,
      CHARGE_ANOMALIES.OVERCHARGE,
      CHARGE_ANOMALIES.INCOMPLETE,
      CHARGE_ANOMALIES.FAILED,
    ]) {
      const input = {
        requestId: 'test-id',
        seller: 'seller',
        offer: 'offer',
        channelId: 'channel',
        depositSignature: 'deposit',
        claimSignature: 'claim',
        ceilingAtomic: '512',
        chargedAtomic: '140',
        expectedAtomic: '140',
        differenceAtomic: '0',
        allowanceAtomic: '6',
        relativeDifference: 0,
        engineTokens: { input: 20, output: 60, prompt: secretPrompt },
        billedTokens: { input: 20, output: 60 },
        recountedTokens: { input: 20, output: 60 },
        countComparison: {
          inputDelta: 0,
          outputDelta: 0,
          withinTolerance: true,
        },
        latencyMs: 1000,
        delivered: anomaly === CHARGE_ANOMALIES.NONE,
        anomaly,
        responseText: secretResponse,
        prompt: secretPrompt,
        content: secretResponse,
        usage: { response: secretResponse },
      };
      const row = measurementRow(input, salt);
      const encoded = JSON.stringify(row);
      assert.ok(
        !encoded.includes(secretPrompt) && !encoded.includes(secretResponse),
      );
      assert.equal(row.firstWordMs, null);
      assert.equal(row.sellerReceipt, null);
      assert.match(row.responseHash, /^[a-f0-9]{64}$/);
      const before = await readFile(path, 'utf8').catch(() => '');
      await appendMeasurement(row, path);
      assert.equal(await readFile(path, 'utf8'), before + encoded + '\n');
    }
    assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded inference rejects tokenized context overflow before signing', async () => {
  const { inferenceCeiling } =
    await import('../packages/node/src/http/inference.js');
  assert.throws(
    () =>
      inferenceCeiling(
        { requestId: 'id', prompt: 'prompt', maxTokens: 128 },
        {
          input: () => 2040,
          count: () => 0,
        } as Parameters<typeof inferenceCeiling>[1],
        2048,
      ),
    /context window/,
  );
});

test('already aborted generation never contacts the local engine', async () => {
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
