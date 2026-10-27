// Validates incremental engine delivery with synthetic HTTP frames only; no model, socket or payment runs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ROUTES } from '@gyblos/config';
import { MODEL, MODEL_LIMITS } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import {
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
} from '@gyblos/protocol/constants';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}
function frame(text: string, done = false) {
  return (
    JSON.stringify({
      model: MODEL.name,
      response: text,
      done,
      ...(done
        ? {
            done_reason: ENGINE_DONE_REASONS.STOP,
            prompt_eval_count: 1,
            eval_count: 2,
            total_duration: 3,
            load_duration: 0,
            prompt_eval_duration: 1,
            eval_duration: 2,
          }
        : {}),
    }) + '\n'
  );
}
function fixture() {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
    },
    cancel() {
      cancelled++;
    },
  });
  const fake: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === ROUTES.ollamaTags)
      return Response.json({
        models: [{ name: MODEL.name, digest: MODEL.digest }],
      });
    assert.equal(url.pathname, ROUTES.ollamaGenerate);
    return new Response(body);
  };
  return {
    engine: createOllamaEngine('http://127.0.0.1:11434', fake),
    push: (text: string) => control.enqueue(new TextEncoder().encode(text)),
    bytes: (bytes: Uint8Array) => control.enqueue(bytes),
    finish: () => control.close(),
    cancelled: () => cancelled,
  };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Synthetic engine did not settle')),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
void test('engine emits a fragment before completion while retaining the complete result', async () => {
  const run = fixture();
  const first = deferred();
  const fragments: string[] = [];
  run.push(frame('first'));
  const generation = run.engine.generate({
    prompt: 'synthetic',
    maxTokens: 2,
    onText: async (text) => {
      fragments.push(text);
      first.resolve();
    },
  });
  try {
    await bounded(first.promise);
    assert.deepEqual(fragments, ['first']);
    run.push(frame('second', true));
    run.finish();
    const result = await generation;
    assert.deepEqual(fragments, ['first', 'second']);
    assert.equal(result.text, 'firstsecond');
    assert.equal(result.usage.outputTokens, 2);
  } finally {
    if (!fragments.length) {
      run.push(frame('', true));
      run.finish();
    }
    await generation.catch(() => {});
  }
});
void test('engine awaits consumer backpressure before emitting the next fragment', async () => {
  const run = fixture();
  const entered = deferred();
  const release = deferred();
  const fragments: string[] = [];
  run.push(frame('first') + frame('second', true));
  run.finish();
  const generation = run.engine.generate({
    prompt: 'synthetic',
    maxTokens: 2,
    onText: async (text) => {
      fragments.push(text);
      if (text === 'first') {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    await bounded(entered.promise);
    assert.deepEqual(fragments, ['first']);
  } finally {
    release.resolve();
    await generation;
  }
  assert.deepEqual(fragments, ['first', 'second']);
});
void test('engine cancellation in a callback suppresses all later buffered fragments', async () => {
  const run = fixture();
  const controller = new AbortController();
  const fragments: string[] = [];
  run.push(frame('first') + frame('second', true));
  const generation = run.engine.generate({
    prompt: 'synthetic',
    maxTokens: 2,
    signal: controller.signal,
    onText: async (text) => {
      fragments.push(text);
      controller.abort();
    },
  });
  await assert.rejects(bounded(generation), { name: 'AbortError' });
  assert.deepEqual(fragments, ['first']);
  assert.equal(run.cancelled(), 1);
});
void test('engine cancellation interrupts a stalled reader even when the injected fetch ignores abort', async () => {
  const run = fixture();
  const controller = new AbortController();
  const entered = deferred();
  const generation = run.engine.generate({
    prompt: 'synthetic',
    maxTokens: 2,
    signal: controller.signal,
    onText: async () => {
      entered.resolve();
    },
  });
  run.push(frame('first'));
  try {
    await bounded(entered.promise);
    controller.abort();
    await assert.rejects(bounded(generation), { name: 'AbortError' });
    assert.equal(run.cancelled(), 1);
  } finally {
    if (!run.cancelled()) {
      run.push(frame('', true));
      run.finish();
    }
    await generation.catch(() => {});
  }
});
void test('engine callback failure cancels the source and suppresses further delivery', async () => {
  const run = fixture();
  const failure = new Error('Synthetic consumer failure');
  const fragments: string[] = [];
  run.push(frame('first') + frame('second', true));
  const generation = run.engine.generate({
    prompt: 'synthetic',
    maxTokens: 2,
    onText: async (text) => {
      fragments.push(text);
      throw failure;
    },
  });
  await assert.rejects(bounded(generation), failure);
  assert.deepEqual(fragments, ['first']);
  assert.equal(run.cancelled(), 1);
});
void test('engine decodes split UTF-8 characters without changing incremental text', async () => {
  const run = fixture();
  const bytes = new TextEncoder().encode(frame('á🙂', true));
  const split = bytes.indexOf(0xc3) + 1;
  run.bytes(bytes.slice(0, split));
  run.bytes(bytes.slice(split));
  run.finish();
  const fragments: string[] = [];
  const result = await run.engine.generate({
    prompt: 'synthetic',
    maxTokens: 2,
    onText: async (text) => {
      fragments.push(text);
    },
  });
  assert.equal(result.text, 'á🙂');
  assert.deepEqual(fragments, ['á🙂']);
});
void test('engine rejects invalid UTF-8 before delivering a corrupted fragment', async () => {
  const run = fixture();
  const bytes = new TextEncoder().encode(frame('x', true));
  const marker = bytes.indexOf(120);
  bytes[marker] = 0xff;
  run.bytes(bytes);
  const fragments: string[] = [];
  await assert.rejects(
    bounded(
      run.engine.generate({
        prompt: 'synthetic',
        maxTokens: 2,
        onText: async (text) => {
          fragments.push(text);
        },
      }),
    ),
  );
  assert.deepEqual(fragments, []);
  assert.equal(run.cancelled(), 1);
});
void test('engine validates output bounds before incremental delivery', async () => {
  const run = fixture();
  run.push(frame('x'.repeat(MODEL_LIMITS.maxOutputCharacters + 1)));
  const fragments: string[] = [];
  await assert.rejects(
    run.engine.generate({
      prompt: 'synthetic',
      maxTokens: 2,
      onText: async (text) => {
        fragments.push(text);
      },
    }),
    { name: 'EngineError', code: ENGINE_ERROR_CODES.INVALID_RESPONSE },
  );
  assert.deepEqual(fragments, []);
  assert.equal(run.cancelled(), 1);
});
void test('engine without a text callback preserves buffering and the existing fragment hook', async () => {
  const run = fixture();
  run.push(frame('first') + frame('second', true));
  run.finish();
  let fragments = 0;
  const result = await run.engine.generate({
    prompt: 'synthetic',
    maxTokens: 2,
    onFragment: async () => {
      fragments++;
    },
  });
  assert.equal(result.text, 'firstsecond');
  assert.equal(result.finishReason, ENGINE_DONE_REASONS.STOP);
  assert.equal(fragments, 2);
});

void test('engine cancellation aborts model inventory before generation starts', async () => {
  const controller = new AbortController();
  const entered = deferred();
  let rejectInventory: (error: Error) => void = () => {};
  let inventorySignal: AbortSignal | null | undefined;
  const fake: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, ROUTES.ollamaTags);
    inventorySignal = init?.signal;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => {
      rejectInventory = reject;
      inventorySignal?.addEventListener(
        'abort',
        () => reject(inventorySignal?.reason),
        { once: true },
      );
    });
  };
  const engine = createOllamaEngine('http://127.0.0.1:11434', fake);
  const generation = engine.generate({
    prompt: 'synthetic',
    maxTokens: 2,
    signal: controller.signal,
  });
  try {
    await bounded(entered.promise);
    controller.abort();
    assert.equal(inventorySignal?.aborted, true);
    await assert.rejects(bounded(generation), { name: 'AbortError' });
  } finally {
    rejectInventory(new Error('Synthetic cleanup'));
    await generation.catch(() => {});
  }
});
