// Verifies an Ollama model manifest against the pinned digest, including a re-pushed manifest whose last
// layer carries the original pinned manifest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const MANIFEST_MEDIA_TYPE =
  'application/vnd.docker.distribution.manifest.v2+json';

interface ModelBlob {
  digest: string;
  size: number;
  mediaType: string;
}
export interface ModelManifest {
  schemaVersion: number;
  mediaType: string;
  config: ModelBlob;
  layers: ModelBlob[];
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function verifyManifestLineage(
  bytes: Uint8Array,
  pinnedDigest: string,
  readBlob: (digest: string) => Promise<Uint8Array>,
): Promise<ModelManifest> {
  const manifest = JSON.parse(
    Buffer.from(bytes).toString('utf8'),
  ) as ModelManifest;
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.mediaType, MANIFEST_MEDIA_TYPE);
  if (digest(bytes) === pinnedDigest) return manifest;
  const provenance = manifest.layers.at(-1);
  assert.ok(provenance);
  assert.equal(provenance.mediaType, MANIFEST_MEDIA_TYPE);
  assert.equal(provenance.digest, `sha256:${pinnedDigest}`);
  const originalBytes = await readBlob(provenance.digest);
  assert.equal(originalBytes.length, provenance.size);
  assert.equal(digest(originalBytes), pinnedDigest);
  const original = JSON.parse(
    Buffer.from(originalBytes).toString('utf8'),
  ) as ModelManifest;
  assert.deepEqual(
    { ...manifest, layers: manifest.layers.slice(0, -1) },
    original,
  );
  return manifest;
}
