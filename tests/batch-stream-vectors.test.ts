// Independent public synthetic stream vectors are checked with WebCrypto and Node/OpenSSL.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { chargeV2 } from '@gyblos/core/pricing-v2';
import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_METHODS,
  batchChannelDigest,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import {
  createBatchStreamVerifier,
  decodeBatchStreamEvent,
  encodeBatchStreamEvent,
} from '@gyblos/protocol/batch-stream';

void test('session-v3 live event vectors match independent canonical bytes, frames and both SHA-256 implementations', async () => {
  const fixture: {
    request: unknown;
    requestDigest: string;
    vectors: { event: unknown; canonical: string; frameHex: string }[];
  } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/batch-stream-v3.json'),
      ),
      'utf8',
    ),
  );
  const request = parseBatchChannelRequest(fixture.request);
  const signing = Buffer.from(
    'gyblos/session-rpc/v3\n' + canonicalJson(request),
  );
  assert.equal(
    createHash('sha256').update(signing).digest('hex'),
    fixture.requestDigest,
  );
  assert.equal(
    Buffer.from(await webcrypto.subtle.digest('SHA-256', signing)).toString(
      'hex',
    ),
    fixture.requestDigest,
  );
  assert.equal(await batchChannelDigest(request), fixture.requestDigest);
  const verifier = await createBatchStreamVerifier(request);
  for (const vector of fixture.vectors) {
    const frame = Buffer.from(vector.frameHex, 'hex');
    assert.equal(frame.readUInt32BE(), frame.length - 4);
    assert.equal(frame.subarray(4).toString(), vector.canonical);
    assert.equal(canonicalJson(vector.event), vector.canonical);
    assert.deepEqual(Buffer.from(encodeBatchStreamEvent(vector.event)), frame);
    assert.deepEqual(decodeBatchStreamEvent(frame), vector.event);
    const accepted = await verifier.accept(vector.event);
    if (
      accepted.terminal?.result &&
      'value' in accepted.terminal.result &&
      request.method === BATCH_METHODS.EXECUTE
    ) {
      const result = accepted.terminal.result;
      assert.equal(
        result.bill.chargedAtomic,
        String(
          chargeV2(
            {
              input: result.value.usage.inputTokens,
              output: result.value.usage.outputTokens,
            },
            request.params.quote.offer.prices,
          ),
        ),
      );
    }
  }
  verifier.finish();
});
