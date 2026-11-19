// A free request asks for zero prices, so when the only seller left is paid (the free one cooling down,
// busy or gone) the buyer says no seller is available, with when to retry, never that its price is above
// budget; any other failure passes through. Pure error mapping and the local HTTP answer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FreeSelectionFailure } from '@gyblos/buyer/free-execution';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { freeSelectionError } from '@gyblos/buyer/slow-seller';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';

const SELECTION = { modelId: 'synthetic', variant: null, quantization: null };
const priceAboveBudget = (retryAt?: number) =>
  new FreeSelectionFailure(
    { ok: false, code: SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET },
    retryAt,
  );

void test('a free request with only a paid seller left reports no candidates, keeping the retry time', () => {
  const retryAt = Date.now() + 20_000;
  const mapped = freeSelectionError(priceAboveBudget(retryAt));
  assert.ok(mapped instanceof FreeSelectionFailure);
  assert.deepEqual(mapped.decision, {
    ok: false,
    code: SELLER_SELECTION_CODES.NO_CANDIDATES,
  });
  assert.equal(mapped.retryAt, retryAt);
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
    async () => {
      throw freeSelectionError(priceAboveBudget(Date.now() + 20_000));
    },
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
