// A free request asks for zero prices, so when the only seller left is paid (the free one cooling down,
// busy or gone) free execution says no seller is available, with when to retry, never that its price is
// above budget; any other failure passes through. Injected selection; the local HTTP answer.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeBuyerFree,
  freeSelectionError,
  FreeSelectionFailure,
  type FreeBuyerDependencies,
} from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';

const SELECTION = { modelId: 'synthetic', variant: null, quantization: null };
const INPUT = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 5,
};
const priceAboveBudget = (retryAt?: number) =>
  new FreeSelectionFailure(
    { ok: false, code: SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET },
    retryAt,
  );
// Free execution whose selection found only a paid seller left.
const onlyPaidLeft = (retryAt?: number): FreeBuyerDependencies => ({
  select: async () => {
    throw priceAboveBudget(retryAt);
  },
  execute: async () => assert.fail('nothing executes'),
});

void test('free execution reports no candidates when only a paid seller is left, keeping the retry time', async () => {
  const retryAt = Date.now() + 20_000;
  await assert.rejects(
    executeBuyerFree(INPUT, onlyPaidLeft(retryAt)),
    (error) =>
      error instanceof FreeSelectionFailure &&
      error.decision.code === SELLER_SELECTION_CODES.NO_CANDIDATES &&
      error.retryAt === retryAt,
  );
  const other = new FreeSelectionFailure({
    ok: false,
    code: SELLER_SELECTION_CODES.LEVEL_UNSUPPORTED,
  });
  assert.equal(freeSelectionError(other), other);
  const unrelated = new Error('boom');
  assert.equal(freeSelectionError(unrelated), unrelated);
});

void test('the local endpoint answers a free request that found only a paid seller with when to retry', async () => {
  const server = await startFreeBuyerHttp(
    (input) => executeBuyerFree(input, onlyPaidLeft(Date.now() + 20_000)),
    { selection: SELECTION, maxTokens: 10 },
    { port: 0 },
  );
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'synthetic',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 503);
    const seconds = Number(response.headers.get('retry-after'));
    assert.ok(seconds >= 19 && seconds <= 20, String(seconds));
    const body = await response.json();
    assert.equal(body.error.code, SELLER_SELECTION_CODES.NO_CANDIDATES);
    assert.doesNotMatch(JSON.stringify(body), /PRICE_ABOVE_BUDGET/);
  } finally {
    await server.close();
  }
});
