// A refused free request names the field and a fixed reason, and a seller that fails during
// selection is reported with its phase and a fixed code. Synthetic input and loopback sellers only;
// reasons never echo prompt text, addresses or keys.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import { FreeBuyerError, parseFreeChat } from '@gyblos/buyer/free-chat';
import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import {
  CONTROL_CODES,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
} from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import { selectionFixture } from './support/buyer-selection';

const SELECTION = { modelId: 'synthetic', variant: null, quantization: null };
const SECRET_PROMPT = 'synthetic-secret-prompt';
const CHAT = {
  model: 'synthetic',
  messages: [{ role: FREE_CHAT_ROLES.USER, content: SECRET_PROMPT }],
};

void test('a refused free chat names the field and why, never the prompt', async () => {
  const cases: [unknown, string | null, RegExp][] = [
    [{ ...CHAT, max_tokens: 0 }, 'max_tokens', /positive integer/],
    [{ ...CHAT, max_tokens: 1.5 }, 'max_tokens', /positive integer/],
    [{ ...CHAT, model: 'other' }, 'model', /model must be synthetic/],
    [{ ...CHAT, tools: [{}] }, 'tools', /tools must be functions/],
    [{ ...CHAT, n: 2 }, 'n', /n is not supported yet/],
    [{ ...CHAT, 'bad key!': 1 }, null, /does not support/],
    [{ ...CHAT, stream: true }, 'stream', /stream must be false or absent/],
    [{ model: 'synthetic' }, 'messages', /non-empty list/],
    [
      {
        ...CHAT,
        messages: [...CHAT.messages, { role: 'assistant', content: 'x' }],
      },
      'messages',
      /must start with a user message/,
    ],
    [
      { ...CHAT, messages: [{ role: 'system', content: SECRET_PROMPT }] },
      'messages',
      /must start with a user message/,
    ],
    [
      {
        ...CHAT,
        messages: [{ role: 'tool', content: SECRET_PROMPT, tool_call_id: 'a' }],
      },
      'messages',
      // A result that answers no call.
      /answer every tool call/,
    ],
    [
      {
        ...CHAT,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'x' } }],
          },
        ],
      },
      'messages',
      /only text content/,
    ],
    [
      {
        ...CHAT,
        messages: [
          { role: 'user', content: 'x'.repeat(FREE_EXECUTION.inputBytes + 1) },
        ],
      },
      'messages',
      /at most \d+ bytes/,
    ],
    [[], null, /JSON object/],
  ];
  for (const [value, param, detail] of cases) {
    const label = JSON.stringify(value).slice(0, 80);
    assert.throws(
      () => parseFreeChat(value, SELECTION, 128),
      (error: unknown) => {
        assert.ok(error instanceof FreeBuyerError, label);
        assert.equal(error.param, param, label);
        const text = String(error.detail);
        assert.match(text, detail, label);
        assert.equal(text.includes(SECRET_PROMPT), false, label);
        return true;
      },
    );
  }
});

void test('free HTTP returns the field in param and the reason in message', async () => {
  const api = await import('@gyblos/buyer/free-http');
  const server = await api.startFreeBuyerHttp(
    async () => {
      throw new Error('never executed');
    },
    { selection: SELECTION, maxTokens: 128 },
    { port: 0 },
  );
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...CHAT, max_tokens: 0 }),
    });
    assert.equal(response.status, 400);
    const value = await response.json();
    assert.equal(value.error.code, 'FREE_BUYER_INVALID_REQUEST');
    assert.equal(value.error.param, 'max_tokens');
    assert.match(value.error.message, /max_tokens must be a positive integer/);
    const broken = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":',
    });
    assert.equal(broken.status, 400);
    const body = await broken.json();
    assert.equal(body.error.param, null);
    assert.match(body.error.message, /JSON/);
  } finally {
    await server.close();
  }
});

void test('selection reports each failing seller with its phase and a fixed code', async () => {
  const run = await selectionFixture();
  try {
    const { windowMs: _default, ...dependencies } = run.dependencies;
    const nodeId = run.config.sellers[0]!.nodeId;
    const select = async (
      patch: Partial<typeof dependencies>,
      quoteWindowMs?: number,
    ) => {
      const failures: unknown[] = [];
      const result = await selectVerifiedBuyerQuote(
        { ...run.config, ...(quoteWindowMs ? { quoteWindowMs } : {}) },
        {
          ...dependencies,
          stats: new Map(),
          onSellerFailure: (failure) => failures.push(failure),
          ...patch,
        },
      );
      return { result, failures };
    };
    // The seller cannot be reached at all.
    const unreachable = await select({
      connect: async () => {
        throw new Error('synthetic dial failure 203.0.113.9');
      },
    });
    assert.equal(unreachable.result.ok, false);
    assert.deepEqual(unreachable.failures, [
      { nodeId, phase: 'connect', code: 'SELLER_ERROR_UNKNOWN' },
    ]);
    // The seller answers the catalog but refuses the quote with a control code.
    run.client.requestOffer = async () => {
      throw new ControlError(CONTROL_CODES.MODEL);
    };
    const refused = await select({ connect: async () => run.client });
    assert.deepEqual(refused.result, {
      ok: false,
      code: BUYER_SELECTION_CODES.NO_OFFER,
    });
    assert.deepEqual(refused.failures, [
      { nodeId, phase: 'quote', code: CONTROL_CODES.MODEL },
    ]);
    // The seller never answers before the window closes.
    run.client.requestOffer = (_params, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('abort')), {
          once: true,
        }),
      );
    const silent = await select({ connect: async () => run.client }, 100);
    assert.deepEqual(silent.failures, [
      { nodeId, phase: 'timeout', code: 'REQUEST_TIMEOUT' },
    ]);
  } finally {
    await run.wire.close();
  }
});

void test('a seller that hangs past the snapshot deadline is reported; a cancelled request is not', async () => {
  const run = await selectionFixture();
  try {
    const { windowMs: _default, ...dependencies } = run.dependencies;
    const nodeId = run.config.sellers[0]!.nodeId;
    const hang = (_seller: unknown, signal?: AbortSignal) =>
      new Promise<boolean>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    const failures: unknown[] = [];
    await selectVerifiedBuyerQuote(run.config, {
      ...dependencies,
      stats: new Map(),
      snapshotMs: 50,
      verifyIdentity: hang,
      onSellerFailure: (failure) => failures.push(failure),
    });
    assert.deepEqual(failures, [
      { nodeId, phase: 'connect', code: 'REQUEST_TIMEOUT' },
    ]);
    const cancelled: unknown[] = [];
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 20);
    await selectVerifiedBuyerQuote(
      run.config,
      {
        ...dependencies,
        stats: new Map(),
        verifyIdentity: hang,
        onSellerFailure: (failure) => cancelled.push(failure),
      },
      caller.signal,
    );
    assert.deepEqual(cancelled, []);
  } finally {
    await run.wire.close();
  }
});

void test('a failure line names the seller briefly and carries no address', async () => {
  const { sellerFailureLine } = await import('@gyblos/buyer/free-main');
  const line = sellerFailureLine({
    nodeId: '8f01b674c2f41e2a810c9f181eda4195134ee5925ec9ad3fdea3e3d1a5f7d560',
    phase: 'quote',
    code: CONTROL_CODES.POLICY,
  });
  assert.equal(
    line,
    'FREE_BUYER_SELLER_FAILED 8f01b674 quote CONTROL_POLICY_MISMATCH',
  );
});
