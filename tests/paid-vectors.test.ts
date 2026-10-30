// Checks the TypeScript paid-execution codec against independently generated golden vectors.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  paidExecutionDigest,
  parsePaidExecutionRequest,
  type PaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';
import {
  createPaidStreamVerifier,
  decodePaidStreamEvent,
  encodePaidStreamEvent,
} from '@gyblos/protocol/paid-stream';
import { PAID_EXECUTION } from '@gyblos/protocol/paid/constants';
import { signingBytes } from '@gyblos/protocol/signing';

interface Vectors {
  request: PaidExecutionRequest;
  requestSigningHex: string;
  requestDigest: string;
  streams: Record<string, { event: unknown; frameHex: string }[]>;
}

async function vectors(): Promise<Vectors> {
  return JSON.parse(
    await readFile(
      fileURLToPath(
        import.meta.resolve('@gyblos/protocol/vectors/paid-execution-v1.json'),
      ),
      'utf8',
    ),
  );
}

void test('the request bytes and digest match the independent vector', async () => {
  const fixture = await vectors();
  const request = parsePaidExecutionRequest(fixture.request);
  assert.equal(
    Buffer.from(signingBytes(PAID_EXECUTION.requestDomain, request)).toString(
      'hex',
    ),
    fixture.requestSigningHex,
  );
  assert.equal(await paidExecutionDigest(request), fixture.requestDigest);
});

void test('every stream frames identically and verifies end to end', async () => {
  const fixture = await vectors();
  assert.deepEqual(Object.keys(fixture.streams).sort(), [
    'full',
    'partial',
    'pending',
    'refused',
    'zero',
  ]);
  for (const [name, events] of Object.entries(fixture.streams)) {
    const verifier = await createPaidStreamVerifier(fixture.request);
    for (const { event, frameHex } of events) {
      assert.equal(
        Buffer.from(encodePaidStreamEvent(event)).toString('hex'),
        frameHex,
        name,
      );
      assert.deepEqual(
        decodePaidStreamEvent(Buffer.from(frameHex, 'hex')),
        event,
        name,
      );
      await verifier.accept(event);
    }
    verifier.finish();
  }
});
