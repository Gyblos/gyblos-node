// The real local HTTP boundary uses synthetic verified outcomes and an in-memory permission journal.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { PAID_VERDICTS } from '@gyblos/node/constants';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { ENGINE_DONE_REASONS, MODEL_IDS } from '@gyblos/protocol/constants';

async function fixture() {
  const scope = {
    network: 'synthetic-network',
    mint: '1'.repeat(32),
    payer: '2'.repeat(32),
  };
  let state: string | undefined;
  const keys = await createBuyerApiKeys({
    scope,
    files: {
      read: async () => state,
      write: async (text) => {
        state = text;
      },
    },
  });
  let calls = 0;
  let uncertain = false;
  const host = await startFreeBuyerHttp(
    async (_input, _signal, _delta, _model, permission) => {
      await permission?.reserve({
        maxAtomic: '60',
        requestId: 'synthetic',
        requestDigest: 'a'.repeat(64),
        sellerNodeId: 'b'.repeat(64),
      });
      calls += 1;
      if (uncertain) throw new Error('synthetic unknown financial outcome');
      const charged = calls === 1 ? '40' : '60';
      return {
        text: 'synthetic answer',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: ENGINE_DONE_REASONS.STOP,
        payment: {
          verdict: PAID_VERDICTS.SETTLED,
          maxAtomic: '60',
          expectedAtomic: charged,
          chargedAtomic: charged,
          sellerAtomic: charged,
          feeAtomic: '0',
          refundedAtomic: String(60 - Number(charged)),
          recorded: false,
          transaction: '3'.repeat(88),
        },
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
      token: 'synthetic-owner-key',
      desktopPolicy: { ...scope, maxAtomic: '60' },
      apiKeys: keys,
    },
  );
  const owner = { authorization: 'Bearer synthetic-owner-key' };
  const response = await fetch(new URL(BUYER_API.STATUS_PATH, host.url), {
    headers: owner,
  });
  const policy = parseBuyerApiPolicy(await response.json());
  return {
    keys,
    host,
    owner,
    policy,
    calls: () => calls,
    uncertain: () => {
      uncertain = true;
    },
  };
}
const body = JSON.stringify({
  model: MODEL_IDS.QWEN3_0_6B,
  messages: [{ role: 'user', content: 'synthetic' }],
  max_tokens: 128,
});
void test('app-created USDC keys share their cap across formats and cannot access owner management', async () => {
  const f = await fixture();
  const url = new URL(BUYER_API_KEYS.PATH, f.host.url);
  try {
    const createdResponse = await fetch(url, {
      method: 'POST',
      headers: {
        ...f.owner,
        'content-type': 'application/json',
        'if-match': '"' + f.policy.policyId + '"',
      },
      body: JSON.stringify({
        action: 'create',
        name: 'Coding tools',
        limitAtomic: '100',
      }),
    });
    assert.equal(createdResponse.status, 200);
    const created = parseBuyerApiKeysReply(
      await createdResponse.json(),
    ).created;
    assert.ok(created);
    const headers = {
      authorization: 'Bearer ' + created.secret,
      'content-type': 'application/json',
    };
    assert.equal(
      (
        await fetch(f.host.url + '?client=one', {
          method: 'POST',
          headers,
          body,
        })
      ).status,
      200,
    );
    const anthropic = await fetch(
      new URL('/v1/messages?client=two', f.host.url),
      {
        method: 'POST',
        headers: {
          'x-api-key': created.secret,
          'content-type': 'application/json',
        },
        body,
      },
    );
    assert.equal(anthropic.status, 200, await anthropic.text());
    const denied = await fetch(new URL(BUYER_API.CHAT_PATH, f.host.url), {
      method: 'POST',
      headers: { ...headers, 'if-match': '"' + f.policy.policyId + '"' },
      body,
    });
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /BUYER_KEY_LIMIT_REACHED/);
    assert.equal(denied.headers.get('x-should-retry'), 'false');
    assert.equal(f.calls(), 2);
    assert.equal(
      (await fetch(new URL('/v1/models', f.host.url), { headers })).status,
      200,
    );
    assert.equal((await fetch(url, { headers })).status, 403);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: 'create',
            name: 'Bypass',
            limitAtomic: '1000',
          }),
        })
      ).status,
      403,
    );
    assert.equal((await f.keys.snapshot()).keys[0]?.spentAtomic, '100');
  } finally {
    await f.host.close();
    await f.keys.close();
  }
});
void test('conflicting credentials and browser origins cannot authorize delegated or owner requests', async () => {
  const f = await fixture();
  try {
    const key = await f.keys.create('Synthetic', '100');
    for (const headers of [
      { ...f.owner, 'x-api-key': key.secret },
      {
        authorization: 'Bearer ' + key.secret,
        'x-api-key': 'synthetic-owner-key',
      },
    ])
      assert.equal(
        (
          await fetch(f.host.url, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body,
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await fetch(new URL(BUYER_API_KEYS.PATH, f.host.url), {
          headers: { ...f.owner, origin: 'https://example.com' },
        })
      ).status,
      403,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.host.close();
    await f.keys.close();
  }
});
void test('an uncertain delegated payment blocks operator Chat and new grants without clearing the reservation', async () => {
  const f = await fixture();
  try {
    const key = await f.keys.create('Synthetic', '100');
    f.uncertain();
    assert.equal(
      (
        await fetch(f.host.url, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + key.secret,
            'content-type': 'application/json',
          },
          body,
        })
      ).status,
      500,
    );
    const root = await fetch(f.host.url, {
      method: 'POST',
      headers: { ...f.owner, 'content-type': 'application/json' },
      body,
    });
    assert.equal(root.status, 503);
    assert.match(await root.text(), /BUYER_KEY_NEEDS_REVIEW/);
    assert.equal(f.calls(), 1);
    assert.equal((await f.keys.snapshot()).keys[0]?.reservedAtomic, '60');
    await assert.rejects(
      f.keys.create('Replacement', '100'),
      /BUYER_KEY_NEEDS_REVIEW/,
    );
  } finally {
    await f.host.close();
    await f.keys.close();
  }
});
