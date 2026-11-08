// The guided command uses injected terminal I/O; actual executable help and non-TTY refusal stay offline.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { runBuyerInit } from '@gyblos/buyer/init';
import { buildBuyerInit, type BuyerInitAnswers } from '@gyblos/node/buyer-init';
import { BUYER_INIT_MODES } from '@gyblos/node/buyer-init-constants';

import { home, owner, sellerNodeId } from './support/buyer-init';

void test('wizard cancellation before answers or at confirmation performs no initialization', async () => {
  for (const confirm of [undefined, 'no']) {
    let writes = 0;
    await runBuyerInit({
      preflight: async () => ({
        path: '/synthetic/buyer/selection.json',
        exists: false,
      }),
      read: async (question) => {
        if (confirm === undefined) return undefined;
        if (question.startsWith('Seller NodeId')) return sellerNodeId;
        if (question.startsWith('Seller owner')) return owner;
        if (question.startsWith('Save')) return confirm;
        return '';
      },
      write: () => {},
      initialize: async () => {
        writes++;
      },
    });
    assert.equal(writes, 0);
  }
});
void test('wizard confirms an explicit USDC ceiling and passes validated answers to shared initialization', async () => {
  let received: BuyerInitAnswers | undefined;
  let output = '';
  await runBuyerInit(
    {
      preflight: async () => ({
        path: '/synthetic/buyer/selection.json',
        exists: false,
      }),
      read: async (question) => {
        if (question.startsWith('Seller NodeId')) return sellerNodeId;
        if (question.startsWith('Seller owner')) return owner;
        if (question.startsWith('Maximum spend')) return '0.01';
        if (question.startsWith('Save')) return 'yes';
        return '';
      },
      write: (text) => {
        output += text;
      },
      initialize: async (input) => {
        received = input;
      },
    },
    BUYER_INIT_MODES.ADVANCED,
  );
  assert.ok(received);
  assert.equal(buildBuyerInit(received).request.maxAtomic, '10000');
  assert.match(output, /ceiling/i);
  assert.match(output, /buyer:chat/);
});

void test('the actual executable offers offline help and refuses unattended initialization without files', async () => {
  const fixture = await home();
  const executable = new URL('../apps/buyer/src/init.ts', import.meta.url)
    .pathname;
  const options = {
    cwd: fixture.directory,
    env: { ...process.env, ...fixture.environment },
    timeout: 10000,
  };
  const args = ['--import', import.meta.resolve('tsx'), executable];
  try {
    const help = await promisify(execFile)(
      process.execPath,
      [...args, '--help'],
      options,
    );
    assert.match(help.stdout, /pnpm buyer:init/);
    await assert.rejects(
      promisify(execFile)(process.execPath, args, options),
      (error: unknown) =>
        error instanceof Error &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        error.stderr.includes('interactive terminal'),
    );
    await assert.rejects(stat(fixture.environment.GYBLOS_HOME), {
      code: 'ENOENT',
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

void test('wizard can explicitly clear nullable model fields while keeping blank answers as defaults', async () => {
  let received: BuyerInitAnswers | undefined;
  await runBuyerInit(
    {
      preflight: async () => ({
        path: '/synthetic/buyer/selection.json',
        exists: false,
      }),
      read: async (question) => {
        if (question.startsWith('Seller NodeId')) return sellerNodeId;
        if (question.startsWith('Seller owner')) return owner;
        if (
          question.startsWith('Variant') ||
          question.startsWith('Quantization')
        )
          return '-';
        if (question.startsWith('Save')) return 'y';
        return '';
      },
      write: () => {},
      initialize: async (input) => {
        received = input;
      },
    },
    BUYER_INIT_MODES.ADVANCED,
  );
  assert.ok(received);
  assert.deepEqual(buildBuyerInit(received).request.selection, {
    modelId: 'qwen3-0.6b',
    variant: null,
    quantization: null,
  });
});
