// Authenticated local metadata never initializes payment or executes a prompt.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_ROUTES } from '@gyblos/buyer/constants';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  MODEL_IDS,
} from '@gyblos/protocol/constants';

void test('buyer metadata is authenticated and stale policy cannot execute', async () => {
  let calls = 0;
  const host = await startFreeBuyerHttp(
    async () => {
      calls++;
      throw new Error('unexpected execution');
    },
    {
      selection: {
        modelId: MODEL_IDS.QWEN3_0_6B,
        variant: null,
        quantization: null,
      },
      maxTokens: 128,
    },
    {
      port: 0,
      token: 'test-bearer-token-which-is-not-a-wallet',
      desktopPolicy: {
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        mint: '11111111111111111111111111111111',
        payer: '11111111111111111111111111111111',
        maxAtomic: '100',
      },
    },
  );
  try {
    const url = new URL(BUYER_API.STATUS_PATH, host.url);
    assert.equal((await fetch(url)).status, 401);
    const headers = {
      authorization: 'Bearer test-bearer-token-which-is-not-a-wallet',
    };
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { policyId: string };
    assert.equal(typeof body.policyId, 'string');
    assert.equal(
      (
        await fetch(url, {
          headers: { ...headers, origin: 'https://example.com' },
        })
      ).status,
      400,
    );
    const stale = await fetch(host.url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'if-match': '"stale-policy"',
      },
      body: JSON.stringify({
        model: MODEL_IDS.QWEN3_0_6B,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(stale.status, 412);
    assert.equal(calls, 0);
  } finally {
    await host.close();
  }
});

void test('desktop policy binding cannot be bypassed by query-bearing chat routes', async () => {
  let calls = 0;
  const host = await startFreeBuyerHttp(
    async () => {
      calls++;
      return {
        text: 'Synthetic reply',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      };
    },
    {
      selection: {
        modelId: MODEL_IDS.QWEN3_0_6B,
        variant: null,
        quantization: null,
      },
      maxTokens: 128,
    },
    {
      port: 0,
      token: 'synthetic-policy-test-bearer-token',
      desktopPolicy: {
        network: 'solana:test',
        mint: '11111111111111111111111111111111',
        payer: '11111111111111111111111111111111',
        maxAtomic: '100',
      },
    },
  );
  try {
    for (const path of [
      new URL(host.url).pathname,
      BUYER_API.CHAT_PATH,
      CHAT_ROUTES.messages,
    ]) {
      const response = await fetch(new URL(path + '?beta=true', host.url), {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-policy-test-bearer-token',
          'content-type': 'application/json',
          'if-match': '"stale-policy"',
        },
        body: JSON.stringify({
          model: MODEL_IDS.QWEN3_0_6B,
          max_tokens: 16,
          messages: [
            { role: FREE_CHAT_ROLES.USER, content: 'Synthetic question' },
          ],
        }),
      });
      assert.equal(response.status, BUYER_API.POLICY_CHANGED_STATUS, path);
    }
    assert.equal(calls, 0);
    const policy = parseBuyerApiPolicy(
      await (
        await fetch(new URL(BUYER_API.STATUS_PATH, host.url), {
          headers: {
            authorization: 'Bearer synthetic-policy-test-bearer-token',
          },
        })
      ).json(),
    );
    for (const path of [
      new URL(host.url).pathname,
      BUYER_API.CHAT_PATH,
      CHAT_ROUTES.messages,
    ]) {
      const url = new URL(path + '?beta=true', host.url);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-policy-test-bearer-token',
          'content-type': 'application/json',
          'if-match': '"' + policy.policyId + '"',
        },
        body: JSON.stringify({
          model: MODEL_IDS.QWEN3_0_6B,
          max_tokens: 16,
          messages: [
            { role: FREE_CHAT_ROLES.USER, content: 'Synthetic question' },
          ],
        }),
      });
      assert.equal(response.status, 200, path);
    }
    assert.equal(calls, 3);
    const missing = await fetch(
      new URL(BUYER_API.CHAT_PATH + '?beta=true', host.url),
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-policy-test-bearer-token',
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    assert.equal(missing.status, BUYER_API.POLICY_CHANGED_STATUS);
    assert.equal(calls, 3);
  } finally {
    await host.close();
  }
});
