// Routed agent requests retain their request-local model and delegated permission across formats.
// Uses only synthetic responses and an in-memory permission journal; no engine or payments.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import type { BuyerExecutionFactory } from '@gyblos/buyer/free-startup';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { ENGINE_DONE_REASONS, MODEL_IDS } from '@gyblos/protocol/constants';

for (const streaming of [false, true])
  void test(`delegated agent model routing preserves permissions with streaming=${streaming}`, async () => {
    let stored: string | undefined;
    const keys = await createBuyerApiKeys({
      scope: {
        network: 'synthetic',
        mint: '1'.repeat(32),
        payer: '2'.repeat(32),
      },
      files: {
        read: async () => stored,
        write: async (text) => {
          stored = text;
        },
      },
    });
    const key = await keys.create('Synthetic tools', '0');
    const selection = {
      modelId: MODEL_IDS.QWEN3_0_6B,
      variant: null,
      quantization: null,
    };
    const selected = { ...selection, variant: 'synthetic' };
    let calls = 0;
    const run: Awaited<ReturnType<BuyerExecutionFactory>>['execute'] = async (
      input,
      _signal,
      delta,
      model,
      permission,
    ) => {
      assert.deepEqual(model?.selection, selected);
      assert.equal(model?.maxTokens, 32);
      assert.equal(input.maxTokens, 16);
      assert.ok(
        permission,
        'the host injects the delegated operation independently of the route',
      );
      assert.equal(permission.ceiling('100'), '0');
      calls++;
      await permission.reserve({
        maxAtomic: '0',
        requestId: `synthetic-${calls}`,
        requestDigest: 'a'.repeat(64),
        sellerNodeId: 'b'.repeat(64),
      });
      await delta?.('synthetic answer');
      return {
        text: 'synthetic answer',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      };
    };
    const host = await startFreeBuyerHttp(
      run,
      {
        selection,
        maxTokens: 64,
        models: [
          { id: 'root', aliases: [], selection, maxTokens: 64 },
          {
            id: 'chosen',
            aliases: ['alias'],
            selection: selected,
            maxTokens: 32,
          },
        ],
        tools: true,
      },
      { port: 0, token: 'synthetic-owner', apiKeys: keys, stream: run },
    );
    try {
      const headers = {
        authorization: `Bearer ${key.secret}`,
        'content-type': 'application/json',
      };
      const models = await fetch(new URL('/v1/models', host.url), { headers });
      assert.equal(models.status, 200);
      assert.match(await models.text(), /"id":"chosen"/);
      for (const path of [
        '/v1/chat/completions',
        '/v1/messages',
        '/v1/responses',
      ]) {
        const body = path.endsWith('/responses')
          ? {
              model: 'alias',
              input: 'synthetic',
              max_output_tokens: 16,
              stream: streaming,
            }
          : {
              model: 'alias',
              messages: [{ role: 'user', content: 'synthetic' }],
              max_tokens: 16,
              stream: streaming,
            };
        const reply = await fetch(new URL(path, host.url), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        assert.equal(reply.status, 200, await reply.text());
      }
      assert.equal(calls, 3);
      const snapshot = await keys.snapshot();
      assert.equal(snapshot.keys[0]?.spentAtomic, '0');
      assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
    } finally {
      await host.close();
      await keys.close();
    }
  });
