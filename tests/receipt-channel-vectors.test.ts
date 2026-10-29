// Verifies new receipt RPC byte vectors without changing receipt/v1 or prior execution vectors.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RECEIPT_CHANNEL } from '@gyblos/protocol/constants';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';
import {
  parseReceiptChannelRequest,
  parseReceiptChannelResponse,
} from '@gyblos/protocol/receipt-channel';
import vectors from '@gyblos/protocol/vectors/receipt-channel-v1.json' with { type: 'json' };

void test('receipt channel independent oracle vectors preserve canonical frames through byte fragmentation', () => {
  for (const row of vectors.cases) {
    const parsed =
      row.kind === 'request'
        ? parseReceiptChannelRequest(row.value)
        : parseReceiptChannelResponse(row.value);
    const frame = encodeControlFrame(parsed, RECEIPT_CHANNEL.frameBytes);
    assert.equal(Buffer.from(frame).toString('hex'), row.frameHex);
    const reader = new ControlFrameReader(RECEIPT_CHANNEL.frameBytes);
    for (const byte of frame) reader.push(Uint8Array.of(byte));
    assert.deepEqual(reader.finish(), row.value);
  }
});
void test('receipt framing rejects duplicate JSON fields, invalid UTF8 and multiple frames', () => {
  for (const body of [
    Buffer.from('{"version":1,"version":1}'),
    Buffer.from([0xff]),
  ]) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length);
    const reader = new ControlFrameReader(RECEIPT_CHANNEL.frameBytes);
    reader.push(Buffer.concat([prefix, body]));
    assert.throws(() => reader.finish());
  }
  const frame = Buffer.from(vectors.cases[0]!.frameHex, 'hex');
  const reader = new ControlFrameReader(RECEIPT_CHANNEL.frameBytes);
  assert.throws(() => reader.push(Buffer.concat([frame, frame])));
});
