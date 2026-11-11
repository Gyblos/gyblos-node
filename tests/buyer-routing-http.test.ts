// Local router busy is a truthful unsent refusal, never a generic uncertain server failure.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FREE_BUYER } from '@gyblos/buyer/constants';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError } from '@gyblos/buyer/paid-http';
import { HTTP_STATUS } from '@gyblos/config';
import { BuyerRoutingError } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import { UnsentSellerBusyError } from '@gyblos/node/buyer-routing';

import { freeSellerFixture } from './support/free-seller';

void test('routing busy and independently proven unsent remote busy are classified as 429 and neverSent', () => {
  for (const error of [
    new BuyerRoutingError(BUYER_ROUTING_CODES.BUSY),
    new UnsentSellerBusyError('12'.repeat(32)),
  ]) {
    const result = classifyPaidError(error);
    assert.equal(result?.status, HTTP_STATUS.tooManyRequests);
    assert.equal(result?.code, BUYER_ROUTING_CODES.BUSY);
    assert.equal(result?.neverSent, true);
  }
});
void test('the real loopback buyer endpoint returns a static unsent routing-busy response', async (t) => {
  const source = await freeSellerFixture();
  const request = await source.request();
  const host = await startFreeBuyerHttp(
    async () => {
      throw new BuyerRoutingError(BUYER_ROUTING_CODES.BUSY);
    },
    {
      selection: request.quote.offer.selection,
      maxTokens: request.quote.offer.maxTokens,
    },
    { port: 0, classify: classifyPaidError },
  );
  t.after(host.close);
  const response = await fetch(host.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: request.quote.offer.selection.modelId,
      messages: request.input.messages,
      max_tokens: request.input.maxTokens,
    }),
  });
  assert.equal(response.status, HTTP_STATUS.tooManyRequests);
  const result = await response.json();
  assert.equal(result.error.code, BUYER_ROUTING_CODES.BUSY);
  assert.equal(response.headers.get(FREE_BUYER.noRetryHeader), null);
});
