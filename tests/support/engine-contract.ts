// Shared Engine port contract: every engine adapter maps the same synthetic upstream behaviors to the
// same outcomes and never leaks upstream text. Harnesses serve fakes on loopback; no real model runs.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENGINE_ERROR_CODES,
  type EngineErrorCode,
} from '@gyblos/protocol/constants';
import { EngineError, type Engine } from '@gyblos/protocol/engine';

export const UPSTREAM_MARKER = 'UPSTREAM-SECRET-MARKER';

export const ENGINE_BEHAVIORS = [
  'ok',
  'ok-stream',
  'status-401',
  'status-402',
  'status-429',
  'status-500',
  'refused',
  'model-missing',
  'error-before-text',
  'error-after-text',
  'truncated-after-text',
  'malformed-before-text',
  'oversize',
  'slow',
  'caller-abort',
  'callback-throws',
] as const;
export type EngineBehavior = (typeof ENGINE_BEHAVIORS)[number];

// Upstream text every successful behavior returns, split across at least two fragments.
export const CONTRACT_TEXT = ['Hello', ' world.'] as const;

export interface EngineHarness {
  // Starts a synthetic upstream for one behavior; the engine's own timeout is generationTimeoutMs.
  // 'ok', 'ok-stream', 'caller-abort' and 'callback-throws' serve CONTRACT_TEXT successfully; the
  // last two let the caller abort or fail from its own callback.
  start(
    behavior: EngineBehavior,
    options: { generationTimeoutMs: number },
  ): Promise<{ engine: Engine; close(): Promise<void> }>;
}

const FAILURES: Partial<Record<EngineBehavior, EngineErrorCode>> = {
  'status-401': ENGINE_ERROR_CODES.AUTH,
  'status-402': ENGINE_ERROR_CODES.QUOTA_EXHAUSTED,
  'status-429': ENGINE_ERROR_CODES.RATE_LIMITED,
  'status-500': ENGINE_ERROR_CODES.UNAVAILABLE,
  refused: ENGINE_ERROR_CODES.UNAVAILABLE,
  'model-missing': ENGINE_ERROR_CODES.UNAVAILABLE,
  'error-before-text': ENGINE_ERROR_CODES.UNAVAILABLE,
  'error-after-text': ENGINE_ERROR_CODES.INTERRUPTED,
  'truncated-after-text': ENGINE_ERROR_CODES.INTERRUPTED,
  'malformed-before-text': ENGINE_ERROR_CODES.INVALID_RESPONSE,
  oversize: ENGINE_ERROR_CODES.INVALID_RESPONSE,
  slow: ENGINE_ERROR_CODES.TIMEOUT,
};
const TIMEOUT_MS = 200;
const TEST_TIMEOUT_MS = 10_000;

// Asserts no upstream marker reaches the error, its stack, own properties or cause chain.
export function assertPrivate(error: unknown): void {
  assert.ok(error instanceof Error);
  const seen = [
    error.message,
    String(error),
    error.stack ?? '',
    ...Object.getOwnPropertyNames(error).map((key) =>
      String(Reflect.get(error, key)),
    ),
  ];
  for (const text of seen) assert.ok(!text.includes(UPSTREAM_MARKER), text);
  if (error.cause !== undefined) assertPrivate(error.cause);
}

async function run(
  harness: EngineHarness,
  behavior: EngineBehavior,
  check: (engine: Engine) => Promise<void>,
) {
  const started = await harness.start(behavior, {
    generationTimeoutMs: TIMEOUT_MS,
  });
  try {
    await check(started.engine);
  } finally {
    await started.close();
  }
}

export function engineContract(name: string, harness: EngineHarness) {
  const options = { timeout: TEST_TIMEOUT_MS };
  void test(
    `${name}: buffered generation returns text and usage`,
    options,
    () =>
      run(harness, 'ok', async (engine) => {
        const result = await engine.generate({
          prompt: 'synthetic',
          maxTokens: 8,
        });
        assert.equal(result.text, CONTRACT_TEXT.join(''));
        assert.ok(result.usage.outputTokens > 0);
      }),
  );
  void test(
    `${name}: streaming delivers every fragment before resolving`,
    options,
    () =>
      run(harness, 'ok-stream', async (engine) => {
        const fragments: string[] = [];
        const result = await engine.generate({
          prompt: 'synthetic',
          maxTokens: 8,
          onText: async (text) => {
            fragments.push(text);
          },
        });
        assert.equal(fragments.join(''), result.text);
        assert.ok(fragments.length >= 2);
      }),
  );
  for (const behavior of ENGINE_BEHAVIORS) {
    const code = FAILURES[behavior];
    if (!code) continue;
    void test(
      `${name}: ${behavior} rejects with EngineError ${code}`,
      options,
      () =>
        run(harness, behavior, async (engine) => {
          const fragments: string[] = [];
          const error = await engine
            .generate({
              prompt: 'synthetic',
              maxTokens: 8,
              onText: async (text) => {
                fragments.push(text);
              },
            })
            .then(
              () => assert.fail('generation should fail'),
              (failure: unknown) => failure,
            );
          assert.ok(error instanceof EngineError, String(error));
          assert.equal(error.code, code);
          assert.equal(error.message, code);
          assertPrivate(error);
          if (code === ENGINE_ERROR_CODES.INTERRUPTED)
            assert.ok(fragments.length >= 1);
        }),
    );
  }
  void test(
    `${name}: caller abort rejects with the caller's reason`,
    options,
    () =>
      run(harness, 'caller-abort', async (engine) => {
        const controller = new AbortController();
        const reason = new Error('synthetic caller abort');
        await assert.rejects(
          engine.generate({
            prompt: 'synthetic',
            maxTokens: 8,
            signal: controller.signal,
            onText: async () => {
              controller.abort(reason);
            },
          }),
          (error: unknown) => error === reason,
        );
      }),
  );
  void test(
    `${name}: a failing caller callback propagates unchanged`,
    options,
    () =>
      run(harness, 'callback-throws', async (engine) => {
        const failure = new Error('synthetic callback failure');
        await assert.rejects(
          engine.generate({
            prompt: 'synthetic',
            maxTokens: 8,
            onText: async () => {
              throw failure;
            },
          }),
          (error: unknown) => error === failure,
        );
      }),
  );
}
