// A paid desktop profile prepares its public tokenizer before channel execution. No wallet or relay.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError } from '@gyblos/buyer/session-errors';
import { sessionMeter } from '@gyblos/buyer/session-requirements';
import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { MODEL_IDS } from '@gyblos/protocol/constants';

import { preparation } from './support/tokenizer-preparation';

const validMeter = { input: () => 1, chat: () => 1, count: () => 1 };

void test('desktop starts one verified tokenizer load for a paid policy and keeps a free policy offline', async () => {
  for (const [desktop, maximum, warmed] of [
    [true, '0', 0],
    [true, '10000', 1],
    [false, '10000', 0],
  ] as const) {
    let calls = 0;
    const load = sessionMeter(maximum, {
      preparePaidTokenizer: desktop,
      meter: async () => {
        calls++;
        return validMeter;
      },
    });
    await Promise.resolve();
    assert.equal(calls, warmed);
    assert.deepEqual(await Promise.all([load(), load()]), [
      validMeter,
      validMeter,
    ]);
    assert.equal(calls, 1);
  }
});

void test('desktop verifies cached artifacts offline and obtains both pinned files for a fresh home', async (t) => {
  for (const cached of [true, false]) {
    const run = await preparation(
      cached ? 'config' : false,
      cached,
      undefined,
      false,
      [],
      'desktop',
    );
    t.after(() => rm(run.directory, { recursive: true, force: true }));
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(
      run.result.stdout,
      new RegExp('downloads=' + (cached ? 0 : 2)),
    );
  }
});

void test('a tokenizer refusal before any channel opens releases the desktop reservation and preserves real uncertainty', async (t) => {
  let available = false;
  const load = sessionMeter('10000', {
    preparePaidTokenizer: true,
    meter: async () => {
      if (!available) throw new Error('private tokenizer details');
      return validMeter;
    },
  });
  const token = 'synthetic-loopback-bearer-token';
  const host = await startFreeBuyerHttp(
    async () => {
      await load();
      throw new Error('synthetic unknown execution result');
    },
    {
      selection: {
        modelId: MODEL_IDS.QWEN3_0_6B,
        variant: null,
        quantization: null,
      },
      maxTokens: 10,
    },
    {
      port: 0,
      token,
      classify: classifyPaidError,
      desktopPolicy: {
        network: DEVNET,
        mint: DEVNET_USDC,
        payer: '11111111111111111111111111111111',
        maxAtomic: '10000',
      },
    },
  );
  t.after(() => host.close());
  let saved: string | undefined;
  const budget = new X402Budget({
    read: async () => saved,
    write: async (value) => {
      saved = value;
    },
  });
  const client = new X402Client(budget);
  t.after(() => client.close());
  await client.connect(host.url, token);
  await client.authorize('10000');
  await assert.rejects(
    client.send('tokenizer-missing', 'Synthetic question'),
    /download|verify/i,
  );
  assert.equal((await budget.summary()).blocked, false);
  assert.equal((await budget.summary()).spentAtomic, '0');
  available = true;
  await assert.rejects(client.send('unknown-result', 'Synthetic question'));
  assert.equal((await budget.summary()).blocked, true);
});
