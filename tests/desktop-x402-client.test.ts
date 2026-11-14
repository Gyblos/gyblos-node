// Synthetic local API responses: no funded wallets, private state or external requests.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getBase58Decoder, isSignature } from '@solana/kit';

import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import {
  buyerEndpoint,
  parseBuyerReply,
  X402Client,
} from '@gyblos/desktop/x402-client';
import { parseX402Result, x402Explorer } from '@gyblos/desktop/x402-model';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
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
void test('a reusable-session approval remains unresolved rather than becoming a settled desktop payment', async () => {
  let posts = 0;
  const ledger = budget();
  const client = new X402Client(ledger, async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(policy);
    posts++;
    const response = reply();
    return Response.json({
      ...response,
      [BUYER_API.PAYMENT_FIELD]: {
        ...response[BUYER_API.PAYMENT_FIELD],
        verdict: SESSION_VERDICTS.APPROVED,
        chargedAtomic: null,
        refundedAtomic: null,
        transaction: undefined,
        recorded: true,
      },
    });
  });
  try {
    await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
    await client.authorize('200');
    await assert.rejects(
      () => client.send('approved-request', 'Hello'),
      /not confirmed/,
    );
    await assert.rejects(() => client.send('blocked-request', 'Do not retry'));
    const summary = await ledger.summary();
    assert.equal(summary.blocked, true);
    assert.equal(summary.spentAtomic, '0');
    assert.deepEqual(summary.records, []);
    assert.equal(posts, 1);
  } finally {
    await client.close();
  }
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

void test('x402 preserves valid reported token usage without treating it as payment evidence', () => {
  const value = {
    ...reply(),
    usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 },
  };
  assert.deepEqual(parseBuyerReply(value, policy).usage, {
    inputTokens: 128,
    outputTokens: 64,
  });
  value.gyblos_payment.verdict = 'pending';
  assert.throws(() => parseBuyerReply(value, policy));
});

void test('x402 treats malformed or absent telemetry as unknown after a valid settlement', () => {
  for (const usage of [
    undefined,
    { prompt_tokens: -1, completion_tokens: 10, total_tokens: 9 },
    { prompt_tokens: 5, completion_tokens: 129, total_tokens: 134 },
    { prompt_tokens: 5, completion_tokens: 10, total_tokens: 99 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 10 },
  ]) {
    const result = parseBuyerReply({ ...reply(), usage }, policy);
    assert.equal(result.usage, null);
    assert.equal(result.chargeAtomic, '30');
  }
});
void test('response observations reach the renderer only after durable settlement and cannot trigger a retry', async () => {
  let posts = 0;
  const client = new X402Client(budget(), async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(policy);
    posts++;
    return Response.json({
      ...reply(),
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
  });
  await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
  await client.authorize('200');
  const result = await client.send('request-1', 'Hello');
  const payload = {
    summary: result.summary,
    policy,
    reply: { text: result.text, model: result.model, metrics: result.metrics },
  };
  const parsed = parseX402Result(payload);
  assert.equal(parsed.reply?.metrics?.inputTokens, 12);
  assert.equal(parsed.reply?.metrics?.outputTokens, 8);
  assert.deepEqual(parsed.reply?.metrics?.cost, {
    amount: '0.000030',
    unit: 'USDC',
    kind: 'settled',
  });
  assert.equal(parsed.reply?.metrics?.firstTokenMs, null);
  assert.equal(parsed.reply?.metrics?.generationMs, null);
  assert.equal(typeof parsed.reply?.metrics?.responseMs, 'number');
  assert.equal(
    parseX402Result({
      ...payload,
      reply: { ...payload.reply, metrics: { responseMs: -1 } },
    }).reply?.metrics,
    undefined,
  );
  assert.equal(posts, 1);
  assert.equal(result.summary.blocked, false);
  await client.close();
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

void test('x402 accepts a valid short Solana signature through reply, persistence and explorer', async () => {
  const bytes = new Uint8Array(64).fill(1);
  bytes[0] = 0;
  const signature = getBase58Decoder().decode(bytes);
  assert.equal(signature.length, 86);
  assert.ok(isSignature(signature));
  const value = reply();
  value[BUYER_API.PAYMENT_FIELD].transaction = signature;
  const parsed = parseBuyerReply(value, policy);
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  const ledger = new X402Budget(files);
  await ledger.authorize(policy, '100');
  await ledger.reserve('short-signature');
  await ledger.complete('short-signature', parsed);
  assert.equal(
    (await new X402Budget(files).summary()).records[0]?.transaction,
    signature,
  );
  assert.equal(
    x402Explorer(signature),
    'https://explorer.solana.com/tx/' + signature + '?cluster=devnet',
  );
  for (const invalid of ['0'.repeat(88), '2'.repeat(80), '2'.repeat(89)])
    assert.throws(() => x402Explorer(invalid));
});
