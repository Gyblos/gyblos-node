// Independent new tool vectors and immutable retired bytes protect version-separated request binding.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  BATCH_METHODS,
  batchChannelDigest,
  batchExecutionDigest,
  matchBatchChannelResponse,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';

void test('tool-only session bytes match independent Node/OpenSSL and WebCrypto with contextual response checks', async () => {
  const vector: {
    request: unknown;
    response: unknown;
    requestSigningHex: string;
    requestDigest: string;
    executionDigest: string;
    requestFrameHex: string;
  } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/batch-tools-v4.json'),
      ),
      'utf8',
    ),
  );
  const request = parseBatchChannelRequest(vector.request);
  assert.equal(request.method, BATCH_METHODS.EXECUTE);
  if (request.method !== BATCH_METHODS.EXECUTE) return assert.fail();
  const bytes = Buffer.from(vector.requestSigningHex, 'hex');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    vector.requestDigest,
  );
  assert.equal(
    Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString(
      'hex',
    ),
    vector.requestDigest,
  );
  assert.equal(await batchChannelDigest(request), vector.requestDigest);
  assert.equal(
    await batchExecutionDigest(request.params),
    vector.executionDigest,
  );
  const response = await matchBatchChannelResponse(vector.response, request);
  assert.ok(response.result && 'value' in response.result);
  assert.equal(response.result.value.text, '');
  assert.equal(response.result.value.toolCalls?.length, 1);
  const changed = structuredClone(response);
  if (!changed.result || !('value' in changed.result)) return assert.fail();
  changed.result.value.toolCalls![0]!.name = 'not_offered';
  await assert.rejects(matchBatchChannelResponse(changed, request));
});
