// Authenticated local metadata never initializes payment or executes a prompt.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { MODEL_IDS } from '@gyblos/protocol/constants';

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
