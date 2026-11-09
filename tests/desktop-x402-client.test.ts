// Synthetic local API responses: no funded wallets, private state or external requests.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import {
  buyerEndpoint,
  parseBuyerReply,
  X402Client,
} from '@gyblos/desktop/x402-client';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

const policy: BuyerApiPolicy = {
  version: 1,
  policyId: '00000000-0000-4000-8000-000000000001',
  model: 'qwen3-0.6b',
  maxTokens: 128,
  maxAtomic: '100',
  network: DEVNET,
  mint: DEVNET_USDC,
  payer: '11111111111111111111111111111111',
};
const token = 'synthetic-ephemeral-local-token';
function budget() {
  let saved: string | undefined;
  return new X402Budget({
    read: async () => saved,
    write: async (text) => {
      saved = text;
    },
  });
}
function reply() {
  return {
    model: policy.model,
    choices: [
      {
        message: { role: 'assistant', content: 'Hello from the model' },
        finish_reason: 'stop',
      },
    ],
    [BUYER_API.EXECUTION_FIELD]: 'paid',
    [BUYER_API.PAYMENT_FIELD]: {
      verdict: 'settled',
      maxAtomic: '100',
      expectedAtomic: '30',
      chargedAtomic: '30',
      refundedAtomic: '70',
      transaction: '2'.repeat(88),
    },
  };
}
void test('x402 refuses non-loopback and credential-bearing endpoints before fetching', () => {
  for (const url of [
    'https://127.0.0.1:8090/v1/chat/completions',
    'http://localhost:8090/v1/chat/completions',
    'http://user:secret@127.0.0.1:8090/v1/chat/completions',
    'http://127.0.0.1:8090/v1/chat/completions?token=secret',
    'http://example.com:8090/v1/chat/completions',
  ])
    assert.throws(() => buyerEndpoint(url));
});
void test('x402 sends once with pinned policy and records only a verified hash', async () => {
  let posts = 0;
  const client = new X402Client(budget(), async (_url, options) => {
    assert.equal(options?.redirect, 'error');
    if (options?.method !== 'POST') return Response.json(policy);
    posts++;
    assert.equal(
      new Headers(options.headers).get('if-match'),
      '"' + policy.policyId + '"',
    );
    return Response.json(reply());
  });
  await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
  await client.authorize('100');
  const result = await client.send('request-1', 'Hello');
  assert.equal(result.text, 'Hello from the model');
  assert.equal(result.summary.records[0]?.transaction, '2'.repeat(88));
  assert.equal(result.summary.spentAtomic, '30');
  assert.equal(posts, 1);
});
void test('x402 changed server policy fails closed without retrying the message', async () => {
  let posts = 0;
  const ledger = budget();
  const client = new X402Client(ledger, async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(policy);
    posts++;
    return Response.json({ error: 'changed' }, { status: 412 });
  });
  await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
  await client.authorize('200');
  await assert.rejects(() => client.send('request-1', 'Hello'));
  await assert.rejects(() => client.send('request-2', 'Hello'));
  assert.equal(posts, 1);
  assert.equal((await ledger.summary()).blocked, true);
});
void test('x402 malformed or unverified settlements never produce a confirmed payment', () => {
  for (const verdict of ['pending', 'unverified', 'disputed', 'interrupted']) {
    const value = reply();
    value[BUYER_API.PAYMENT_FIELD].verdict = verdict;
    assert.throws(() => parseBuyerReply(value, policy));
  }
  const mismatch = reply();
  mismatch[BUYER_API.PAYMENT_FIELD].chargedAtomic = '101';
  assert.throws(() => parseBuyerReply(mismatch, policy));
  assert.throws(() =>
    parseBuyerReply(
      { ...reply(), [BUYER_API.PAYMENT_FIELD]: undefined },
      policy,
    ),
  );
});
void test('x402 explicit free result needs no invented hash; token-limited result is still complete', () => {
  const value = {
    ...reply(),
    [BUYER_API.EXECUTION_FIELD]: 'free',
    [BUYER_API.PAYMENT_FIELD]: undefined,
  };
  assert.equal(parseBuyerReply(value, policy).transaction, null);
  const limited = reply();
  limited.choices[0]!.finish_reason = 'length';
  assert.equal(parseBuyerReply(limited, policy).transaction, '2'.repeat(88));
});
void test('x402 concurrent sends transmit at most one request', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  const client = new X402Client(budget(), async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(policy);
    posts++;
    await held;
    return Response.json(reply());
  });
  await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
  await client.authorize('200');
  const first = client.send('request-1', 'Hello');
  await assert.rejects(() => client.send('request-2', 'Hello'));
  release();
  await first;
  assert.equal(posts, 1);
});
void test('x402 releases a reservation only when the buyer explicitly proves the request was never sent', async () => {
  const ledger = budget();
  const client = new X402Client(ledger, async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(policy);
    return Response.json(
      { error: { code: 'BUYER_POLICY_CHANGED', gyblos_never_sent: true } },
      { status: 412 },
    );
  });
  await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
  await client.authorize('100');
  await assert.rejects(() => client.send('request-1', 'Hello'));
  assert.equal((await ledger.summary()).blocked, false);
  assert.equal((await ledger.summary()).spentAtomic, '0');
  await ledger.finish();
});
