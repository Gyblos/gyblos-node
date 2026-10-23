// Checks that model integrity accepts only the pinned manifest and its Ollama provenance, and detects
// changed weights, config or a substituted manifest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { verifyManifestLineage } from '@gyblos/engine-ollama/artifacts';

const ORIGINAL = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: {
    digest: 'sha256:synthetic-config',
    size: 1,
    mediaType: 'synthetic',
  },
  layers: [
    { digest: 'sha256:synthetic-weights', size: 1, mediaType: 'synthetic' },
  ],
};
const BYTES = Buffer.from(JSON.stringify(ORIGINAL));
const PIN = createHash('sha256').update(BYTES).digest('hex');

function wrapped() {
  return {
    ...ORIGINAL,
    layers: [
      ...ORIGINAL.layers,
      {
        digest: `sha256:${PIN}`,
        size: BYTES.length,
        mediaType: ORIGINAL.mediaType,
      },
    ],
  };
}

void test('model integrity accepts the exact pinned manifest and its unchanged Ollama provenance envelope', async () => {
  assert.deepEqual(
    await verifyManifestLineage(BYTES, PIN, async () => {
      throw new Error('No blob read expected');
    }),
    ORIGINAL,
  );
  const envelope = wrapped();
  assert.deepEqual(
    await verifyManifestLineage(
      Buffer.from(JSON.stringify(envelope)),
      PIN,
      async () => BYTES,
    ),
    envelope,
  );
});

void test('provenance cannot hide changed weights/config or a substituted original manifest', async () => {
  for (const field of ['config', 'layers'] as const) {
    const changed = wrapped();
    if (field === 'config')
      changed.config = { ...changed.config, digest: 'sha256:changed' };
    else
      changed.layers[0] = { ...changed.layers[0]!, digest: 'sha256:changed' };
    await assert.rejects(
      verifyManifestLineage(
        Buffer.from(JSON.stringify(changed)),
        PIN,
        async () => BYTES,
      ),
    );
  }
  await assert.rejects(
    verifyManifestLineage(
      Buffer.from(JSON.stringify(wrapped())),
      PIN,
      async () => Buffer.from('corrupt'),
    ),
  );
});
