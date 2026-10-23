// Exercises canonical control framing and response shapes without opening sockets.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_METHODS,
  CONTROL_VERSION,
} from '@gyblos/protocol/constants';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';
import { parseControlQuery } from '@gyblos/protocol/control-requests';
import { parseControlResponse } from '@gyblos/protocol/control-response';

const query = {
  version: CONTROL_VERSION,
  requestId: 'a'.repeat(32),
  method: CONTROL_METHODS.CATALOG,
  params: {},
};
function rawFrame(text: string | Uint8Array) {
  const body = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const frame = new Uint8Array(body.length + CONTROL_LIMITS.prefixBytes);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, CONTROL_LIMITS.prefixBytes);
  return frame;
}
void test('control framing handles fragmented prefixes and bytes only after EOF', () => {
  const frame = encodeControlFrame(query);
  const reader = new ControlFrameReader();
  for (const byte of frame) reader.push(Uint8Array.of(byte));
  assert.deepEqual(parseControlQuery(reader.finish()), query);
  assert.throws(() => reader.finish(), { code: CONTROL_CODES.INVALID });
  assert.throws(() => reader.push(Uint8Array.of(1)), {
    code: CONTROL_CODES.INVALID,
  });
});
void test('control rejects excessive prefixes before buffering and refuses incomplete or trailing frames', () => {
  const prefix = new Uint8Array(CONTROL_LIMITS.prefixBytes);
  new DataView(prefix.buffer).setUint32(0, CONTROL_LIMITS.requestBytes + 1);
  assert.throws(() => new ControlFrameReader().push(prefix), {
    code: CONTROL_CODES.LIMIT,
  });
  const frame = encodeControlFrame(query);
  for (let end = 0; end < frame.length; end++) {
    const reader = new ControlFrameReader();
    reader.push(frame.subarray(0, end));
    assert.throws(() => reader.finish(), { code: CONTROL_CODES.INVALID });
  }
  const reader = new ControlFrameReader();
  reader.push(frame);
  assert.throws(() => reader.push(frame), { code: CONTROL_CODES.INVALID });
});
void test('control rejects duplicate JSON keys, noncanonical JSON, deep trees and invalid UTF-8', () => {
  for (const body of [
    '{"x":1,"x":2}',
    '{"x": 1}',
    '{"z":1,"a":2}',
    '[',
    '1e400',
    '9007199254740992',
    '{"x":1.5}',
    new Uint8Array([255]),
    '\ufeff{}',
  ]) {
    const reader = new ControlFrameReader();
    reader.push(rawFrame(body));
    assert.throws(() => reader.finish(), { code: CONTROL_CODES.INVALID });
  }
  const nested =
    '['.repeat(CONTROL_LIMITS.depth + 1) +
    '0' +
    ']'.repeat(CONTROL_LIMITS.depth + 1);
  const reader = new ControlFrameReader();
  reader.push(rawFrame(nested));
  assert.throws(() => reader.finish(), { code: CONTROL_CODES.LIMIT });
});
void test('control uses separate response bounds and exactly one result or static error', () => {
  const error = {
    version: CONTROL_VERSION,
    requestId: query.requestId,
    error: { code: CONTROL_CODES.BUSY },
  };
  assert.deepEqual(parseControlResponse(error), error);
  for (const value of [
    { ...error, result: {} },
    { ...error, error: { code: 'PRIVATE_SENTINEL' } },
    { ...error, requestId: 'PRIVATE_SENTINEL' },
    { ...error, error: { ...error.error, message: 'PRIVATE_SENTINEL' } },
  ])
    assert.throws(() => parseControlResponse(value), {
      code: CONTROL_CODES.INVALID,
      message: CONTROL_CODES.INVALID,
    });
  const response = encodeControlFrame(
    'a'.repeat(CONTROL_LIMITS.requestBytes),
    CONTROL_LIMITS.responseBytes,
  );
  assert.throws(() => new ControlFrameReader().push(response), {
    code: CONTROL_CODES.LIMIT,
  });
  const reader = new ControlFrameReader(CONTROL_LIMITS.responseBytes);
  reader.push(response);
  assert.equal(reader.finish(), 'a'.repeat(CONTROL_LIMITS.requestBytes));
  assert.throws(() => parseControlQuery({ ...query, version: 999 }), {
    code: CONTROL_CODES.VERSION,
  });
  assert.throws(
    () =>
      parseControlQuery({ ...query, params: { prompt: 'PRIVATE_SENTINEL' } }),
    { code: CONTROL_CODES.INVALID },
  );
});
