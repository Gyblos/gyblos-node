// The seller's free router sends each request to the offer its quote selected and refuses a selection no
// offer serves with UNSUPPORTED. Synthetic quotes and engines; no files, network or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSellerFreeRouter } from '@gyblos/node/free-router';
import { canonicalJson } from '@gyblos/protocol';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  freeExecutionDigest,
  parseFreeExecutionRequest,
} from '@gyblos/protocol/free-execution';

import { freeSellerFixture, freeSellerSignal } from './support/free-seller';

void test('a request reaches the offer its quote selected, for responses and streams', async () => {
  const seller = await freeSellerFixture();
  const routed: ModelSelection[] = [];
  const router = createSellerFreeRouter((selection) => {
    routed.push(selection);
    return canonicalJson(selection) === canonicalJson(seller.options.selection)
      ? seller.service
      : undefined;
  });
  const response = await router.respond(
    await seller.request(1),
    seller.source.request.params.buyerNodeId,
    freeSellerSignal(),
  );
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result?.text, 'answer');
  const deltas: string[] = [];
  const streamed = await router.stream!(
    await seller.request(2),
    seller.source.request.params.buyerNodeId,
    freeSellerSignal(),
    async (text) => {
      deltas.push(text);
    },
  );
  assert.equal(streamed.error, undefined, JSON.stringify(streamed.error));
  assert.equal(deltas.join(''), 'answer');
  assert.deepEqual(routed, [
    seller.options.selection,
    seller.options.selection,
  ]);
});

void test('a selection no offer serves is refused as UNSUPPORTED without reaching any engine', async () => {
  const seller = await freeSellerFixture();
  const router = createSellerFreeRouter(() => undefined);
  const value = await seller.request(1);
  const response = await router.respond(
    value,
    seller.source.request.params.buyerNodeId,
    freeSellerSignal(),
  );
  const request = parseFreeExecutionRequest(value);
  assert.deepEqual(response, {
    version: request.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
    error: { code: FREE_EXECUTION_CODES.UNSUPPORTED },
  });
  assert.equal(seller.calls(), 0);
});
