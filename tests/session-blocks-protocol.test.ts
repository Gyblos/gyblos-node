// Synthetic block contracts exercise real assertions before their parsers and digest are implemented.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import {
  BatchChannelError,
} from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  decodeSessionBlock,
  encodeSessionBlock,
  parseSessionBlock,
  sessionBlockDigest,
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
} from '@gyblos/protocol/session-blocks';

const binding = {
  version: SESSION_BLOCKS.version,
  channelId: '11111111111111111111111111111111',
  requestId: '11'.repeat(16),
  requestDigest: '22'.repeat(32),
  index: 0,
};
const block = {
  ...binding,
  kind: SESSION_BLOCK_KINDS.CHECKPOINT,
  text: 'a',
  usage: { inputTokens: 2, outputTokens: 1 },
  bill: {
    requestId: binding.requestId,
    requestDigest: binding.requestDigest,
    maxAtomic: '20',
    chargedAtomic: '3',
    cumulativeAtomic: '8',
  },
  terminal: null,
};
const invalid = (code: string) => (error: unknown) =>
  error instanceof BatchChannelError && error.code === code;

void test('session block canonical roundtrip and independently computed digest', async () => {
  assert.deepEqual(parseSessionBlock(block), block);
  const bytes = encodeSessionBlock(block);
  assert.deepEqual(decodeSessionBlock(bytes), block);
  const canonical = Buffer.from(bytes.subarray(4)).toString();
  assert.equal(
    await sessionBlockDigest(block),
    createHash('sha256').update(SESSION_BLOCKS.digestDomain + canonical).digest('hex'),
  );
});

for (const [name, value] of [
  ['old version', { ...block, version: 4 }],
  ['unknown field', { ...block, extra: true }],
  ['uppercase identity', { ...block, requestDigest: 'AB'.repeat(32) }],
  ['fractional index', { ...block, index: 0.1 }],
  ['exhausted index', { ...block, index: SESSION_BLOCKS.maxBlocks }],
  ['negative usage', { ...block, usage: { ...block.usage, outputTokens: -1 } }],
  ['excess output', { ...block, usage: { ...block.usage, outputTokens: 129 } }],
  ['noncanonical amount', { ...block, bill: { ...block.bill, chargedAtomic: '03' } }],
  ['unknown nested field', { ...block, bill: { ...block.bill, extra: true } }],
] ) {
  void test(`session block rejects ${name}`, () => {
    assert.throws(() => parseSessionBlock(value), invalid(SESSION_CODES.INVALID));
  });
}
for (const [name, value] of [
  ['different request', { ...block, bill: { ...block.bill, requestId: '44'.repeat(16) } }],
  ['different digest', { ...block, bill: { ...block.bill, requestDigest: '44'.repeat(32) } }],
  ['terminal usage', { ...block, terminal: { text: 'a', usage: { inputTokens: 2, outputTokens: 2 }, finishReason: ENGINE_DONE_REASONS.STOP } }],
]) {
  void test(`session block binds ${name}`, () => {
    assert.throws(() => parseSessionBlock(value), invalid(SESSION_CODES.BINDING));
  });
}
void test('session blocks accept final usage and native voucher exchange', async () => {
  const terminal = { text: 'a', usage: block.usage, finishReason: ENGINE_DONE_REASONS.STOP };
  assert.deepEqual(parseSessionBlock({ ...block, terminal }), { ...block, terminal });
  const blockDigest = await sessionBlockDigest(block);
  for (const frame of [
    { ...binding, kind: SESSION_BLOCK_KINDS.APPROVAL, blockDigest, voucher: { channelId: binding.channelId, maxClaimableAmount: '8', expiresAt: 0, signature: '1'.repeat(64) } },
    { ...binding, kind: SESSION_BLOCK_KINDS.ACK, blockDigest, cumulativeAtomic: '8' },
    { ...binding, kind: SESSION_BLOCK_KINDS.FAILURE, code: SESSION_CODES.CLOSED },
  ]) assert.deepEqual(decodeSessionBlock(encodeSessionBlock(frame)), frame);
});
void test('session block rejects malformed and noncanonical frames', () => {
  const canonical = encodeSessionBlock(block);
  assert.throws(() => decodeSessionBlock(canonical.subarray(0, canonical.length - 1)), invalid(SESSION_CODES.INVALID));
  assert.throws(() => decodeSessionBlock(new Uint8Array([...canonical, 0])), invalid(SESSION_CODES.INVALID));
  const body = Buffer.from(JSON.stringify(block));
  const header = Buffer.alloc(4);header.writeUInt32BE(body.length);
  assert.throws(() => decodeSessionBlock(Buffer.concat([header,body])), invalid(SESSION_CODES.INVALID));
});
void test('session block rejects excessive prefix before body allocation', () => {
  const prefix = Buffer.alloc(4);prefix.writeUInt32BE(SESSION_BLOCKS.frameBytes + 1);
  assert.throws(() => decodeSessionBlock(prefix), invalid(SESSION_CODES.LIMIT));
});
void test('session approval cannot substitute another channel', () => {
  assert.throws(() => parseSessionBlock({ ...binding, kind: SESSION_BLOCK_KINDS.APPROVAL, blockDigest: '33'.repeat(32), voucher: { channelId: '22222222222222222222222222222222', maxClaimableAmount: '8', expiresAt: 0, signature: '1'.repeat(64) } }), invalid(SESSION_CODES.BINDING));
});
void test('session failure never reflects arbitrary remote messages', () => {
  assert.throws(() => parseSessionBlock({ ...binding, kind: SESSION_BLOCK_KINDS.FAILURE, code: 'private-content' }), invalid(SESSION_CODES.INVALID));
});
