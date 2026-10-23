// Checks the bounded HTTP wire: raw request and x402 header preservation, route and smuggling rejection,
// peer limits and deadlines.
import assert from 'node:assert/strict';
import test from 'node:test';

import { P2P, ROUTES } from '@gyblos/config';
import { withDeadline } from '@gyblos/transport-iroh/deadline';
import { createPeerLimiter } from '@gyblos/transport-iroh/limiter';
import {
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
} from '@gyblos/transport-iroh/wire';

const REQUEST = {
  method: 'POST',
  path: ROUTES.inference,
  headers: {
    'content-type': 'application/json',
    'payment-signature': 'synthetic-payment-header',
  },
  body: Buffer.from('{"prompt":"synthetic"}'),
};

void test('bounded HTTP wire preserves raw synthetic request bytes and x402 headers', () => {
  const decoded = decodeRequest(encodeRequest(REQUEST));
  assert.equal(decoded.method, 'POST');
  assert.equal(decoded.path, ROUTES.inference);
  assert.deepEqual(decoded.headers, REQUEST.headers);
  assert.deepEqual(decoded.body, REQUEST.body);
  for (const status of [200, 402, 502]) {
    const reply = {
      status,
      headers: {
        'content-type': 'application/json',
        'payment-required': 'synthetic-challenge',
        'payment-response': 'synthetic-receipt',
      },
      body: Buffer.from('synthetic-response'),
    };
    assert.deepEqual(decodeResponse(encodeResponse(reply)), reply);
  }
});

void test('HTTP wire rejects non-inference routes and request smuggling or oversized bodies', () => {
  for (const path of [
    '/api/generate',
    '/supported',
    '/facilitator/events',
    'http://localhost/other',
  ])
    assert.throws(() => encodeRequest({ ...REQUEST, path }));
  assert.throws(() => encodeRequest({ ...REQUEST, method: 'CONNECT' }));
  assert.throws(() =>
    encodeRequest({ ...REQUEST, body: Buffer.alloc(P2P.bodyBytes + 1) }),
  );
  for (const extra of [
    'content-length: 0\r\n',
    'transfer-encoding: chunked\r\n',
    'content-length: -1\r\n',
  ])
    assert.throws(() =>
      decodeRequest(
        Buffer.from(
          `POST ${ROUTES.inference} HTTP/1.1\r\ncontent-type: application/json\r\ncontent-length: 2\r\n${extra}\r\n{}`,
        ),
      ),
    );
  assert.throws(() =>
    decodeRequest(
      Buffer.concat([
        encodeRequest(REQUEST),
        Buffer.from('POST /extra HTTP/1.1'),
      ]),
    ),
  );
});

void test('per-peer and global limits cannot be bypassed with duplicate release or unbounded peers', () => {
  let now = 0;
  const limiter = createPeerLimiter(() => now);
  const first = limiter.enter('one');
  const second = limiter.enter('two');
  assert.ok(first && second);
  assert.equal(limiter.enter('three'), undefined);
  first();
  first();
  assert.ok(limiter.enter('three'));
  second();
  now += P2P.rateWindowMs;
  const rate = createPeerLimiter(() => now);
  for (let index = 0; index < P2P.requestsPerWindow; index++) {
    const release = rate.enter('same');
    assert.ok(release);
    release();
  }
  assert.equal(rate.enter('same'), undefined);
  now += P2P.rateWindowMs;
  assert.ok(rate.enter('same'));
});

void test('deadline closes the native connection rather than waiting for a locked stream mutex', async () => {
  let closed = false;
  await assert.rejects(
    withDeadline(new Promise<never>(() => {}), 1, () => {
      closed = true;
    }),
    /uncertain/,
  );
  assert.equal(closed, true);
});
