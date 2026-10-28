// The seller's free router sends each request to the offer whose selection its quote names, reading the
// offers on every request, and refuses a selection no offer serves with UNSUPPORTED before any engine
// work. Synthetic quotes and engines; no files, network or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSellerFreeRouter,
  type FreeOffer,
} from '@gyblos/node/free-router';
import {
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import {
  freeExecutionDigest,
  parseFreeExecutionRequest,
} from '@gyblos/protocol/free-execution';

import { freeSellerFixture, freeSellerSignal } from './support/free-seller';
import { freeStreamSellerFixture } from './support/free-stream-seller';

const OTHER_SELECTION = {
  modelId: 'qwen3-8b',
  variant: null,
  quantization: 'Q4_K_M',
};

void test('a request reaches the offer its quote selected, for responses and streams', async () => {
  const seller = await freeStreamSellerFixture();
  const untouched = await freeStreamSellerFixture();
  const router = createSellerFreeRouter(() => [
    { selection: OTHER_SELECTION, service: untouched.service },
    // Key order differs from the quote's; the match is canonical.
    {
      selection: {
        quantization: seller.options.selection.quantization,
        variant: seller.options.selection.variant,
        modelId: seller.options.selection.modelId,
      },
      service: seller.service,
    },
  ]);
  const peer = seller.source.request.params.buyerNodeId;
  const response = await router.respond(
    await seller.request(1),
    peer,
    freeSellerSignal(),
  );
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result?.text, 'answer');
  const deltas: string[] = [];
  const streamed = await router.stream(
    await seller.request(2),
    peer,
    freeSellerSignal(),
    async (text) => {
      deltas.push(text);
    },
  );
  assert.equal(streamed.error, undefined, JSON.stringify(streamed.error));
  assert.equal(deltas.join(''), 'answer');
  assert.equal(seller.calls(), 2);
  assert.equal(untouched.calls(), 0);
});

void test('an offer added later is routed from then on', async () => {
  const seller = await freeSellerFixture();
  const offers: FreeOffer[] = [];
  const router = createSellerFreeRouter(() => offers);
  const peer = seller.source.request.params.buyerNodeId;
  const before = await router.respond(
    await seller.request(1),
    peer,
    freeSellerSignal(),
  );
  assert.equal(before.error?.code, FREE_EXECUTION_CODES.UNSUPPORTED);
  offers.push({ selection: seller.options.selection, service: seller.service });
  const after = await router.respond(
    await seller.request(2),
    peer,
    freeSellerSignal(),
  );
  assert.equal(after.error, undefined, JSON.stringify(after.error));
});

void test('a selection no offer serves is refused as UNSUPPORTED without reaching any engine', async () => {
  const seller = await freeSellerFixture();
  const router = createSellerFreeRouter(() => []);
  const value = await seller.request(1);
  const response = await router.respond(
    value,
    seller.source.request.params.buyerNodeId,
    freeSellerSignal(),
  );
  const request = parseFreeExecutionRequest(value);
  assert.deepEqual(response, {
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
    error: { code: FREE_EXECUTION_CODES.UNSUPPORTED },
  });
  assert.equal(seller.calls(), 0);
});

void test('a value that is not a free request rejects, as a single offer did', async () => {
  const router = createSellerFreeRouter(() => []);
  const pending = router.respond({ nope: 1 }, 'peer', freeSellerSignal());
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending);
});
