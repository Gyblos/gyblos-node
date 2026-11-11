// Verifies canonical execution framing and immutable independent vectors; no sockets or real engines.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONTROL_DOMAINS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import {
  freeExecutionDigest,
  matchFreeExecutionResponse,
  parseFreeExecutionRequest,
  parseFreeExecutionResponse,
  verifyFreeExecutionRequest,
} from '@gyblos/protocol/free-execution';
import {
  encodeFreeExecutionRequest,
  encodeFreeExecutionResponse,
  FreeExecutionRequestReader,
  FreeExecutionResponseReader,
} from '@gyblos/protocol/free-execution-framing';
import { signingBytes } from '@gyblos/protocol/signing';

interface Vector {
  ownerPublicKeyHex: string;
  request: unknown;
  requestDigest: string;
  requestSigningHex: string;
  requestFrameHex: string;
  response: unknown;
  responseFrameHex: string;
  error: unknown;
  errorFrameHex: string;
  cannotContinue: { error: Record<string, unknown> } & Record<string, unknown>;
  cannotContinueFrameHex: string;
}
async function vector(): Promise<Vector> {
  return JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/free-execution-v4.json'),
      ),
      'utf8',
    ),
  );
}
function rawFrame(text: string) {
  const bytes = Buffer.from(text);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}
void test('free execution golden request bytes and digest match an independent oracle', async () => {
  const source = await vector();
  assert.equal(await freeExecutionDigest(source.request), source.requestDigest);
  assert.equal(
    Buffer.from(
      signingBytes(FREE_EXECUTION.requestDomain, source.request),
    ).toString('hex'),
    source.requestSigningHex,
  );
  assert.equal(
    Buffer.from(encodeFreeExecutionRequest(source.request)).toString('hex'),
    source.requestFrameHex,
  );
  const request = parseFreeExecutionRequest(source.request);
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(source.ownerPublicKeyHex, 'hex'),
    ]),
    type: 'spki',
    format: 'der',
  });
  assert.equal(
    verify(
      null,
      signingBytes(CONTROL_DOMAINS.OFFER, request.quote.offer),
      key,
      Buffer.from(request.quote.signature, 'base64'),
    ),
    true,
  );
  assert.deepEqual(
    await verifyFreeExecutionRequest(request, {
      owner: request.quote.offer.owner,
      nodeId: request.quote.offer.nodeId,
      remoteNodeId: request.quote.offer.buyerNodeId,
      now: request.quote.offer.issuedAt,
    }),
    request,
  );
});
void test('free execution golden response and static error frames match and bind the request', async () => {
  const source = await vector();
  assert.equal(
    Buffer.from(encodeFreeExecutionResponse(source.response)).toString('hex'),
    source.responseFrameHex,
  );
  assert.equal(
    Buffer.from(encodeFreeExecutionResponse(source.error)).toString('hex'),
    source.errorFrameHex,
  );
  assert.equal(
    (await matchFreeExecutionResponse(source.response, source.request)).text,
    'Hello.',
  );
  await assert.rejects(
    matchFreeExecutionResponse(source.error, source.request),
    { code: FREE_EXECUTION_CODES.BUSY },
  );
});
void test('free execution reads fragmented prefixes/bodies and returns only after EOF', async () => {
  const source = await vector();
  const reader = new FreeExecutionRequestReader();
  for (const byte of Buffer.from(source.requestFrameHex, 'hex'))
    reader.push(Uint8Array.of(byte));
  assert.deepEqual(reader.finish(), source.request);
  assert.throws(() => reader.finish(), { code: FREE_EXECUTION_CODES.INVALID });
  assert.throws(() => reader.push(Uint8Array.of(0)), {
    code: FREE_EXECUTION_CODES.INVALID,
  });
  const response = new FreeExecutionResponseReader();
  response.push(Buffer.from(source.responseFrameHex, 'hex'));
  assert.deepEqual(response.finish(), source.response);
});
void test('free execution rejects excessive lengths before bodies, incomplete and additional messages', async () => {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(FREE_EXECUTION.requestBytes + 1);
  assert.throws(() => new FreeExecutionRequestReader().push(prefix), {
    code: FREE_EXECUTION_CODES.LIMIT,
  });
  const source = await vector();
  const frame = Buffer.from(source.requestFrameHex, 'hex');
  const short = new FreeExecutionRequestReader();
  short.push(frame.subarray(0, frame.length - 1));
  assert.throws(() => short.finish(), { code: FREE_EXECUTION_CODES.INVALID });
  assert.throws(
    () => new FreeExecutionRequestReader().push(Buffer.concat([frame, frame])),
    { code: FREE_EXECUTION_CODES.INVALID },
  );
});
void test('free execution rejects ambiguous JSON, duplicate keys, deep objects and invalid UTF-8', () => {
  for (const text of [
    '{ "version":2}',
    '{"version":2,"version":2}',
    '{"v":1e0}',
    '['.repeat(18) + '0' + ']'.repeat(18),
  ]) {
    const reader = new FreeExecutionRequestReader();
    reader.push(rawFrame(text));
    assert.throws(() => reader.finish(), {
      code: text.startsWith('[')
        ? FREE_EXECUTION_CODES.LIMIT
        : FREE_EXECUTION_CODES.INVALID,
    });
  }
  const reader = new FreeExecutionRequestReader();
  reader.push(Uint8Array.of(0, 0, 0, 1, 255));
  assert.throws(() => reader.finish(), { code: FREE_EXECUTION_CODES.INVALID });
});

void test('free execution reader cannot resume a valid request after a framing violation', async () => {
  const source = await vector();
  const reader = new FreeExecutionRequestReader();
  reader.push(Buffer.from(source.requestFrameHex, 'hex'));
  assert.throws(() => reader.push(Uint8Array.of(0)), {
    code: FREE_EXECUTION_CODES.INVALID,
  });
  assert.throws(() => reader.finish(), { code: FREE_EXECUTION_CODES.INVALID });
});

void test('free execution v4 pins the seller-cannot-continue terminal and its reason', async () => {
  const source = await vector();
  assert.equal(FREE_EXECUTION.version, 4);
  assert.equal(
    Buffer.from(encodeFreeExecutionResponse(source.cannotContinue)).toString(
      'hex',
    ),
    source.cannotContinueFrameHex,
  );
  await assert.rejects(
    matchFreeExecutionResponse(source.cannotContinue, source.request),
    (error: unknown) =>
      error instanceof Error &&
      Reflect.get(error, 'code') ===
        FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE &&
      Reflect.get(error, 'reason') ===
        FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED &&
      Reflect.get(error, 'delivered') === undefined &&
      Reflect.get(error, 'remote') === true,
  );
});
void test('free execution error shape ties reason and delivered to seller-cannot-continue', async () => {
  const source = await vector();
  const base = source.cannotContinue;
  const cannot = FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE;
  const delivered = { outputTokens: 2 };
  for (const error of [
    { code: cannot },
    { code: cannot, reason: 'unknown_reason' },
    { code: cannot, reason: 'engine_auth' },
    { code: FREE_EXECUTION_CODES.BUSY, reason: 'quota_exhausted' },
    { code: FREE_EXECUTION_CODES.ENGINE, delivered },
    { code: cannot, reason: 'quota_exhausted', delivered: { outputTokens: 0 } },
    {
      code: cannot,
      reason: 'quota_exhausted',
      delivered: { outputTokens: 1.5 },
    },
    {
      code: cannot,
      reason: 'quota_exhausted',
      delivered: { outputTokens: 1, extra: 1 },
    },
    { code: cannot, reason: 'quota_exhausted', extra: true },
  ])
    assert.throws(
      () => parseFreeExecutionResponse({ ...base, error }),
      { code: FREE_EXECUTION_CODES.INVALID },
      JSON.stringify(error),
    );
  assert.deepEqual(
    parseFreeExecutionResponse({
      ...base,
      error: { code: cannot, reason: 'engine_interrupted', delivered },
    }).error,
    { code: cannot, reason: 'engine_interrupted', delivered },
  );
});
void test('free execution delivered usage is rejected for complete responses and bounded for streams', async () => {
  const source = await vector();
  const cannot = FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE;
  const response = (outputTokens: number) => ({
    ...source.cannotContinue,
    error: {
      code: cannot,
      reason: 'engine_interrupted',
      delivered: { outputTokens },
    },
  });
  await assert.rejects(
    matchFreeExecutionResponse(response(1), source.request),
    { code: FREE_EXECUTION_CODES.INVALID },
  );
  await assert.rejects(
    matchFreeExecutionResponse(response(32), source.request, 'stream'),
    (error: unknown) =>
      error instanceof Error &&
      Reflect.get(error, 'code') === cannot &&
      Reflect.get(error, 'reason') === 'engine_interrupted' &&
      Reflect.get(Reflect.get(error, 'delivered') ?? {}, 'outputTokens') === 32,
  );
  await assert.rejects(
    matchFreeExecutionResponse(response(33), source.request, 'stream'),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
});
