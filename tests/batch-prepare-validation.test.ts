// Agreement parsing and refusal guards never create financial authority, even for a valid peer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  matchBatchTerms,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

import { batchPrepareFixture } from './support/batch-prepare';

async function vectorTerms() {
  const vector: { response: { result: { terms: PaymentSessionTerms } } } =
    JSON.parse(
      await readFile(
        new URL(
          import.meta.resolve('@gyblos/protocol/vectors/batch-prepare-v1.json'),
        ),
        'utf8',
      ),
    );
  return vector.response.result.terms;
}
void test('PREPARE strictly parses remote and locally authorized terms, including private unknown fields', async () => {
  const terms = await vectorTerms();
  assert.deepEqual(matchBatchTerms(terms, terms), terms);
  const invalid: unknown[] = [
    { ...terms, depositAtomic: '00' },
    { ...terms, depositAtomic: '0' },
    { ...terms, depositAtomic: '18446744073709551616' },
    { ...terms, expiresAt: 0 },
    { ...terms, expiresAt: 0.5 },
    { ...terms, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...terms, protocolFeeBps: 10001 },
    { ...terms, protocolFeeBps: -1 },
    { ...terms, withdrawDelaySeconds: 0 },
    { ...terms, buyerNodeId: 'AB'.repeat(32) },
    { ...terms, network: 'invalid' },
    { ...terms, buyer: 'invalid' },
    { ...terms, unknown: true },
    { ...terms, [Symbol('unknown')]: true },
  ];
  for (const value of invalid) {
    assert.throws(() => matchBatchTerms(value, terms), {
      code: SESSION_CODES.INVALID,
    });
    assert.throws(() => matchBatchTerms(terms, value), {
      code: SESSION_CODES.INVALID,
    });
  }
});
void test('PREPARE request refuses unknown params before reaching the service', async (t) => {
  const f = await batchPrepareFixture();
  t.after(f.close);
  const quote = await f.offers.quote(1);
  assert.throws(
    () =>
      parseBatchChannelRequest({
        version: BATCH_CHANNEL.version,
        requestId: '12'.repeat(16),
        method: BATCH_METHODS.PREPARE,
        params: { quote, depositAtomic: '999999999' },
      }),
    { code: SESSION_CODES.INVALID },
  );
  assert.deepEqual(f.rig.calls, []);
});
void test('PREPARE refuses wrong peer, signatures, expired quote, busy and stale readiness without financial methods', async (t) => {
  const f = await batchPrepareFixture();
  t.after(f.close);
  const methods = [
    'open',
    'reserve',
    'finish',
    'accept',
    'close',
    'tick',
    'snapshot',
  ] as const;
  const mocks = methods.map((method) => t.mock.method(f.session, method));
  const quote = await f.offers.quote(1);
  const request = {
    version: BATCH_CHANNEL.version,
    requestId: '12'.repeat(16),
    method: BATCH_METHODS.PREPARE,
    params: { quote },
  };
  const exchange = (value = request, peer = f.rig.terms.buyerNodeId) =>
    f.service.exchange(
      parseBatchChannelRequest(value),
      peer,
      new AbortController().signal,
    );
  await assert.rejects(exchange(request, '56'.repeat(32)), {
    code: PAID_EXECUTION_CODES.PEER,
  });
  await assert.rejects(
    exchange({
      ...request,
      params: {
        quote: { ...quote, signature: Buffer.alloc(64).toString('base64') },
      },
    }),
    { code: PAID_EXECUTION_CODES.SIGNATURE },
  );
  f.offers.busy(true);
  await assert.rejects(exchange(), { code: PAID_EXECUTION_CODES.BUSY });
  f.offers.busy(false);
  f.offers.down(true);
  await assert.rejects(exchange(), { code: PAID_EXECUTION_CODES.ENGINE });
  f.offers.down(false);
  f.rig.time(quote.offer.expiresAt);
  await assert.rejects(exchange(), { code: PAID_EXECUTION_CODES.EXPIRED });
  assert.deepEqual(
    mocks.map((mock) => mock.mock.callCount()),
    methods.map(() => 0),
  );
  assert.equal(f.offers.generations(), 0);
  assert.deepEqual(f.rig.calls, []);
});

for (const expires of ['quote', 'session'] as const) {
  void test(`PREPARE seller rejects ${expires} expiry during signature verification`, async (t) => {
    const f = await batchPrepareFixture();
    t.after(f.close);
    const quote = await f.offers.quote(1);
    const terms = { ...f.rig.terms, expiresAt: f.rig.now() + 1 };
    const service =
      expires === 'quote'
        ? f.service
        : createSellerBatchSession({
            session: f.session,
            terms,
            offers: () => [f.offers.live],
            now: f.rig.now,
          });
    const original = crypto.subtle.verify.bind(crypto.subtle);
    t.mock.method(
      crypto.subtle,
      'verify',
      async (...args: Parameters<typeof original>) => {
        const valid = await original(...args);
        f.rig.time(
          expires === 'quote' ? quote.offer.expiresAt : terms.expiresAt,
        );
        return valid;
      },
    );
    await assert.rejects(
      service.exchange(
        parseBatchChannelRequest({
          version: BATCH_CHANNEL.version,
          requestId: '12'.repeat(16),
          method: BATCH_METHODS.PREPARE,
          params: { quote },
        }),
        terms.buyerNodeId,
        new AbortController().signal,
      ),
      {
        code:
          expires === 'quote'
            ? PAID_EXECUTION_CODES.EXPIRED
            : SESSION_CODES.LIMIT,
      },
    );
    assert.equal(f.offers.generations(), 0);
    assert.deepEqual(f.rig.calls, []);
  });
}
