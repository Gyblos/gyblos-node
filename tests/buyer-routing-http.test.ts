// Local router busy is a truthful unsent refusal, never a generic uncertain server failure.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FREE_BUYER, PAID_BUYER_CODES } from '@gyblos/buyer/constants';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { delegatedFreeResends } from '@gyblos/buyer/quote-selection';
import { classifyPaidError } from '@gyblos/buyer/session-errors';
import { HTTP_STATUS } from '@gyblos/config';
import { BuyerRoutingError } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { UnsentSellerBusyError } from '@gyblos/node/buyer-routing';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type { DiagnosticRecord } from '@gyblos/runtime/diagnostics';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

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
  const records: DiagnosticRecord[] = [];
  const host = await startFreeBuyerHttp(
    async () => {
      throw new BuyerRoutingError(BUYER_ROUTING_CODES.BUSY);
    },
    {
      selection: request.quote.offer.selection,
      maxTokens: request.quote.offer.maxTokens,
    },
    {
      port: 0,
      classify: classifyPaidError,
      diagnostics: (record) => records.push(record),
    },
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
  assert.deepEqual(
    records.map((record) => record.code),
    [BUYER_ROUTING_CODES.BUSY],
  );
});

void test('a local queue expiry is a typed unsent gateway timeout', () => {
  const result = classifyPaidError(
    new BuyerRoutingError(BUYER_ROUTING_CODES.QUEUE_TIMEOUT),
  );
  assert.equal(result?.status, HTTP_STATUS.gatewayTimeout);
  assert.equal(result?.code, BUYER_ROUTING_CODES.QUEUE_TIMEOUT);
  assert.equal(result?.neverSent, true);
});

void test('a financial blocker during free reselection retains its code and disables SDK retry after a possible send', async (t) => {
  const policy = delegatedFreeResends(true);
  policy.onResend?.(new FreeClientError(FREE_EXECUTION_CODES.TIMEOUT, true));
  const fixture = await freeSellerFixture();
  const request = await fixture.request();
  const host = await startFreeBuyerHttp(
    async () => {
      throw policy.selectionError(
        new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED),
      );
    },
    {
      selection: request.quote.offer.selection,
      maxTokens: request.quote.offer.maxTokens,
    },
    { port: 0, classify: classifyPaidError },
  );
  t.after(host.close);
  const resp = await fetch(host.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: request.quote.offer.selection.modelId,
      messages: request.input.messages,
    }),
  });
  assert.equal(resp.headers.get(FREE_BUYER.noRetryHeader), 'false');
  const message = (await resp.json()).error;
  assert.equal(message.code, PAID_BUYER_CODES.UNRESOLVED);
  assert.equal(message[BUYER_API.NEVER_SENT_FIELD], false);
});
