// Owns subprocess containment regressions using a synthetic Pi executable and no credentials.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REVIEW_FAILURE } from './constants';
import { runPi } from './pi';

async function withProcess(
  script: string,
  run: (directory: string, entry: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-fake-pi-'));
  const entry = join(directory, 'fake.mjs');
  await writeFile(entry, script);
  try {
    await run(directory, entry);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test('Pi receives prompt through stdin with all tools disabled', async () => {
  await withProcess(
    "let input=''; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({input,args:process.argv.slice(2)})}],usage:{totalTokens:123}}}));",
    async (directory, entry) => {
      const result = await runPi({
        command: process.execPath,
        prefixArgs: [entry],
        cwd: directory,
        env: { PATH: process.env.PATH },
        model: 'openai/example',
        thinking: 'high',
        prompt: 'synthetic source',
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.reportedTokens, 123);
      assert.match(result.stdout, /synthetic source/);
      assert.match(result.stdout, /--no-tools/);
      assert.equal(result.timedOut, false);
    },
  );
});

void test('Pi output overflow terminates a noisy child', async () => {
  await withProcess(
    "setInterval(() => { process.stdout.write('x'.repeat(100000)); }, 1);",
    async (directory, entry) => {
      const result = await runPi({
        command: process.execPath,
        prefixArgs: [entry],
        cwd: directory,
        env: {},
        model: 'openai/example',
        thinking: 'high',
        prompt: 'input',
        timeoutMs: 5000,
      });
      assert.equal(result.truncated, true);
      assert.ok(result.stdout.length <= 5_242_880);
    },
  );
});

void test('Pi timeout stops a child that ignores SIGTERM', async () => {
  await withProcess(
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);",
    async (directory, entry) => {
      const result = await runPi({
        command: process.execPath,
        prefixArgs: [entry],
        cwd: directory,
        env: {},
        model: 'openai/example',
        thinking: 'high',
        prompt: 'input',
        timeoutMs: 500,
      });
      assert.equal(result.timedOut, true);
      assert.ok(result.signal);
    },
  );
});

void test('a missing Pi executable fails promptly without leaking diagnostics', async () => {
  await withProcess('', async (directory) => {
    await assert.rejects(
      runPi({
        command: join(directory, 'missing-pi'),
        cwd: directory,
        env: {},
        model: 'openai/example',
        thinking: 'high',
        prompt: 'input',
      }),
      /Unable to start/,
    );
  });
});

void test('provider refusals are named by class, never by their text', async () => {
  for (const [errorMessage, expected] of [
    [
      'OpenAI API error (404): {"code":"model_not_found"}',
      REVIEW_FAILURE.MODEL,
    ],
    [
      'The model `gpt-x` does not exist or you do not have access to it.',
      REVIEW_FAILURE.MODEL,
    ],
    [
      'OpenAI API error (400): {"code":"context_length_exceeded"}',
      REVIEW_FAILURE.CONTEXT,
    ],
    [
      'OpenAI API error (400): {"code":"unsupported_value","param":"reasoning.effort"}',
      REVIEW_FAILURE.REQUEST,
    ],
    [
      'OpenAI API error (503): {"type":"server_error"}',
      REVIEW_FAILURE.PROVIDER,
    ],
    ['OpenAI API error (401): {"code":"invalid_api_key"}', REVIEW_FAILURE.KEY],
    ['socket hang up', REVIEW_FAILURE.PI],
  ] as const) {
    const event = {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage },
    };
    await withProcess(
      'console.log(' + JSON.stringify(JSON.stringify(event)) + ');',
      async (cwd, entry) => {
        const result = await runPi({
          cwd,
          command: process.execPath,
          prefixArgs: [entry],
          env: {},
          model: 'openai/example',
          thinking: 'high',
          prompt: 'mock',
        });
        assert.equal(result.failure, expected, errorMessage);
      },
    );
  }
});

void test('temporary limits and successful model text cannot trip the quota stop', async () => {
  for (const [stopReason, expected] of [
    ['error', REVIEW_FAILURE.RATE],
    ['stop', undefined],
  ] as const) {
    const event = {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason,
        errorMessage: '429 Rate limit reached for requests',
        content: [{ type: 'text', text: 'insufficient_quota' }],
      },
    };
    await withProcess(
      'console.log(' + JSON.stringify(JSON.stringify(event)) + ');',
      async (cwd, entry) => {
        const result = await runPi({
          cwd,
          command: process.execPath,
          prefixArgs: [entry],
          env: {},
          model: 'openai/example',
          thinking: 'high',
          prompt: 'mock',
        });
        assert.equal(result.failure, expected);
      },
    );
  }
});
