// Synthetic buyer errors and ephemeral delegated keys; no real profile, prompt, payment or remote service.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { desktopBuyerFailure } from '@gyblos/desktop/buyer-error';
import { CHAT_FAILURE } from '@gyblos/desktop/chat-archive-model';
import {
  emptyUsdcApi,
  parseUsdcApiSecret,
  USDC_API_ACTION,
  usdcApiKeyBadge,
} from '@gyblos/desktop/usdc-api-model';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createX402Handlers } from '@gyblos/desktop/x402-handlers';
import { parseX402Result, X402_ACTION } from '@gyblos/desktop/x402-model';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';
import {
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { desktopAgentFixture } from './support/desktop-agent';
import { chunk, frame, policy } from './support/desktop-stream';

void test('free seller selection does not tell a free-only buyer to add funds', () => {
  const error = desktopBuyerFailure(
    {
      code: SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET,
      message: 'SYNTHETIC_SECRET_CANARY',
    },
    policy,
  );
  assert.match(error.message, /No free seller is available/);
  assert.doesNotMatch(error.message, /CANARY|fund|raise|SELLER_PRICE/);
});
void test('timeout and free allowance failures explain an action without reflecting remote messages', () => {
  assert.match(
    desktopBuyerFailure(
      {
        code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        reason: FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT,
      },
      policy,
    ).message,
    /time|shorten/i,
  );
  assert.match(
    desktopBuyerFailure({ code: FREE_EXECUTION_CODES.BUYER_CAP }, policy)
      .message,
    /allowance|later/i,
  );
});

void test('output limits and paid engine quotas are not mislabelled as long history or a free allowance', () => {
  const limit = desktopBuyerFailure(
    { code: FREE_EXECUTION_CODES.LIMIT },
    policy,
  );
  assert.match(limit.message, /request or response/i);
  const quota = desktopBuyerFailure(
    {
      code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
      reason: FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED,
    },
    { ...policy, maxAtomic: '100' },
  );
  assert.match(quota.message, /quota/i);
  assert.doesNotMatch(
    quota.message,
    /free allowance|conversation is too long/i,
  );
});
void test('a zero-budget key is labelled free-only while revoked and uncertain state still take precedence', async (t) => {
  const fixture = await desktopAgentFixture();
  t.after(() => fixture.close());
  const state = await fixture.run(USDC_API_ACTION.COPY_URL);
  const key = state.snapshot!.keys[0]!;
  assert.equal(usdcApiKeyBadge(state, key), 'Free only');
  assert.equal(
    usdcApiKeyBadge({ ...state, error: 'unavailable' }, key),
    'Needs review',
  );
  assert.equal(
    usdcApiKeyBadge(
      { ...state, snapshot: { ...state.snapshot!, blocked: true } },
      key,
    ),
    'Needs review',
  );
  assert.equal(
    usdcApiKeyBadge(emptyUsdcApi(), { ...key, revoked: true }),
    'Revoked',
  );
});
void test('revealing a key is explicit, main-frame scoped, transient and unavailable after revocation', async (t) => {
  const fixture = await desktopAgentFixture();
  t.after(() => fixture.close());
  const input = { id: fixture.id, policyId: fixture.client.policy()!.policyId };
  const reveal = await fixture.host.reveal(fixture.event, [input]);
  assert.equal(reveal.id, fixture.id);
  assert.equal(reveal.policyId, input.policyId);
  assert.match(reveal.secret, /^gyb_/);
  const state = await fixture.run(USDC_API_ACTION.COPY_URL);
  assert.ok(!JSON.stringify(state).includes(reveal.secret));
  await assert.rejects(
    fixture.host.reveal({ ...fixture.event, senderFrame: {} }, [input]),
  );
  await assert.rejects(
    fixture.host.reveal(fixture.event, [{ ...input, secret: 'injected' }]),
  );
  await fixture.run(USDC_API_ACTION.REVOKE);
  await assert.rejects(fixture.host.reveal(fixture.event, [input]));
  fixture.host.close();
  await assert.rejects(fixture.host.reveal(fixture.event, [input]));
});

void test('HTTP and streaming failures reach the desktop as static guidance with one prompt attempt', async () => {
  for (const [streaming, limit] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    let posts = 0;
    let partial = '';
    const budget = new X402Budget({
      read: async () => undefined,
      write: async () => {},
    });
    const client = new X402Client(budget, async (_url, options) => {
      if (options?.method !== 'POST') return Response.json(policy);
      posts++;
      const error = {
        code: limit
          ? FREE_EXECUTION_CODES.LIMIT
          : FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        reason: FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT,
        message: 'PRIVATE_CANARY_DO_NOT_REFLECT',
      };
      return streaming
        ? new Response(
            limit
              ? Buffer.concat([
                  frame(chunk('Visible partial answer')),
                  frame({ error }),
                ])
              : frame({ error }),
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          )
        : Response.json({ error }, { status: 502 });
    });
    const contents = {};
    const mainFrame = {};
    const handler = createX402Handlers(
      client,
      budget,
      { contents, mainFrame: () => mainFrame, destroyed: () => false },
      async () => {},
      undefined,
      undefined,
      streaming
        ? (event) => {
            partial += event.text;
          }
        : undefined,
    );
    try {
      await client.connect(
        'http://127.0.0.1:8090/v1/chat/completions',
        'synthetic-operator-token',
      );
      await client.authorize('0');
      const result = await handler(
        { sender: contents, senderFrame: mainFrame },
        [
          {
            action: X402_ACTION.SEND,
            id: 'synthetic-request',
            prompt: 'synthetic',
          },
        ],
      );
      if (streaming && limit) assert.equal(partial, 'Visible partial answer');
      if (limit)
        assert.equal(
          parseX402Result(result).failureReason,
          FREE_EXECUTION_CODES.LIMIT,
        );
      else assert.match(result.error ?? '', /did not finish in time/);
      assert.match(result.error ?? '', /not retried/);
      assert.doesNotMatch(
        JSON.stringify(result),
        /PRIVATE_CANARY|ENGINE_TIMEOUT|SELLER_CANNOT/,
      );
      assert.equal(posts, 1);
      assert.equal(result.reply, undefined);
      assert.equal(result.summary.blocked, false);
    } finally {
      await client.close();
    }
  }
});

for (const [code, neverSent, reason] of [
  [FREE_EXECUTION_CODES.TIMEOUT, false, undefined],
  [BUYER_KEY_CODES.REVIEW, false, BUYER_KEY_CODES.REVIEW],
  [BUYER_KEY_CODES.REVIEW, true, CHAT_FAILURE.KEY_REVIEW_NOT_SENT],
  [PAID_EXECUTION_CODES.EXPIRED, true, PAID_EXECUTION_CODES.EXPIRED],
  [PAID_EXECUTION_CODES.EXPIRED, false, undefined],
  [BUYER_API.TOKENIZER_UNAVAILABLE, true, BUYER_API.TOKENIZER_UNAVAILABLE],
  [PAID_EXECUTION_CODES.PEER, true, PAID_EXECUTION_CODES.PEER],
  [SESSION_CODES.BINDING, true, CHAT_FAILURE.NOT_SENT],
  [SESSION_CODES.BINDING, false, undefined],
  ['UNKNOWN_CODE', true, undefined],
] as const) {
  void test(`the buyer handler validates the turn reason for ${code} (never sent: ${neverSent})`, async () => {
    const paid = {
      ...policy,
      model: 'qwen3-0.6b',
      depositAtomic: '25000',
      lifetimeMs: 900000,
      maxAtomic: '100',
    };
    const budget = new X402Budget({
      read: async () => undefined,
      write: async () => {},
    });
    let posts = 0;
    const client = new X402Client(budget, async (_url, options) => {
      if (options?.method !== 'POST') return Response.json(paid);
      posts++;
      return Response.json(
        {
          error: {
            code,
            message: 'REMOTE_ERROR_CANARY',
            [BUYER_API.NEVER_SENT_FIELD]: neverSent,
          },
        },
        { status: 502 },
      );
    });
    const contents = {};
    const mainFrame = {};
    const handler = createX402Handlers(
      client,
      budget,
      { contents, mainFrame: () => mainFrame, destroyed: () => false },
      async () => {},
      undefined,
      undefined,
      undefined,
      (id) =>
        id === 'confirmed'
          ? {
              nodeId: 'a'.repeat(64),
              owner: paid.payer,
              modelId: paid.model,
              variant: null,
              quantization: null,
              contextTokens: 2048,
              inputAtomicPerMtok: '30',
              outputAtomicPerMtok: '90',
              expiresAt: Date.now() + 60000,
            }
          : undefined,
    );
    try {
      await client.connect(
        'http://127.0.0.1:8090/v1/chat/completions',
        'synthetic-operator-token',
      );
      await client.authorize('100');
      const unconfirmed = await handler(
        { sender: contents, senderFrame: mainFrame },
        [
          {
            action: X402_ACTION.SEND,
            id: 'before-confirmation',
            prompt: 'synthetic',
          },
        ],
      );
      assert.match(unconfirmed.error ?? '', /select a seller/i);
      assert.equal(posts, 0);
      const stale = await handler(
        { sender: contents, senderFrame: mainFrame },
        [
          {
            action: X402_ACTION.SEND,
            offerId: 'stale',
            policyId: paid.policyId,
            id: 'stale-request',
            prompt: 'synthetic',
          },
        ],
      );
      assert.equal(
        parseX402Result(stale).failureReason,
        CHAT_FAILURE.STALE_OFFER,
      );
      assert.equal(posts, 0);
      const result = await handler(
        { sender: contents, senderFrame: mainFrame },
        [
          {
            action: X402_ACTION.SEND,
            id: 'synthetic-paid',
            offerId: 'confirmed',
            policyId: paid.policyId,
            prompt: 'synthetic',
          },
        ],
      );
      if (!neverSent)
        assert.match(result.error ?? '', /Spending status needs review/);
      const parsed = parseX402Result(result);
      assert.equal(parsed.failureReason, reason);
      assert.doesNotMatch(JSON.stringify(parsed), /REMOTE_ERROR_CANARY/);
      assert.equal(result.summary.blocked, !neverSent);
      assert.equal(posts, 1);
      assert.equal((await budget.summary()).records.length, 0);
    } finally {
      await client.close();
    }
  });
}
void test('secret replies reject extra fields and a navigation during refresh prevents a late reveal', async (t) => {
  const fixture = await desktopAgentFixture();
  t.after(() => fixture.close());
  const input = { id: fixture.id, policyId: fixture.client.policy()!.policyId };
  const secret = await fixture.host.reveal(fixture.event, [input]);
  assert.deepEqual(parseUsdcApiSecret(secret), secret);
  assert.throws(() => parseUsdcApiSecret({ ...secret, other: 'extra' }));
  assert.throws(() => parseUsdcApiSecret({ ...secret, secret: 'invalid' }));
  const manage = fixture.client.manageApiKeys.bind(fixture.client);
  fixture.client.manageApiKeys = async (...args) => {
    const result = await manage(...args);
    fixture.event.senderFrame = {};
    return result;
  };
  await assert.rejects(fixture.host.reveal(fixture.event, [input]));
});
