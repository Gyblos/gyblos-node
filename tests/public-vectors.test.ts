// Checks committed public vectors with both Web Crypto and independent OpenSSL.
// The generator retained only synthetic public material, never private signers.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import test from 'node:test';

import {
  canonicalJson,
  catalogDigest,
  parsePublicRecord,
  PUBLIC_RECORD_DOMAINS,
  PUBLIC_RECORD_ERROR_CODES,
  PUBLIC_RECORD_KINDS,
  signingBytes,
  verifyPublicRecord,
} from '@gyblos/protocol';
import vector from '@gyblos/protocol/vectors/public-discovery-v1.json' with { type: 'json' };

const NODE_PUBLIC_KEY = createPublicKey({
  key: {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(vector.publicKeyHex, 'hex').toString('base64url'),
  },
  format: 'jwk',
});

for (const entry of vector.vectors) {
  void test(`public ${entry.record.kind} golden vector fixes its domain, canonical bytes and signature`, async () => {
    const record = parsePublicRecord(entry.record);
    assert.equal(entry.domain, `gyblos/${record.kind}/v1\n`);
    assert.equal(PUBLIC_RECORD_DOMAINS[record.kind], entry.domain);
    assert.equal(record.nodeId, vector.publicKeyHex);
    assert.equal(canonicalJson(record), entry.canonicalJson);
    const bytes = Buffer.from(signingBytes(entry.domain, record));
    assert.equal(bytes.toString('hex'), entry.signingBytesHex);
    assert.equal(
      verify(
        null,
        bytes,
        NODE_PUBLIC_KEY,
        Buffer.from(entry.signatureHex, 'hex'),
      ),
      true,
    );
    const catalog = parsePublicRecord(vector.vectors[0]!.record);
    assert.equal(catalog.kind, PUBLIC_RECORD_KINDS.CATALOG);
    if (catalog.kind !== PUBLIC_RECORD_KINDS.CATALOG) return;
    const trust = {
      owner: record.owner,
      nodeId: record.nodeId,
      now: record.issuedAt,
      catalog,
    };
    assert.deepEqual(
      await verifyPublicRecord(
        { record: entry.record, signature: entry.signatureHex },
        trust,
      ),
      record,
    );
    // Property order is not signed JSON order; the canonical representation is stable.
    const reordered: unknown = Object.fromEntries(
      Object.entries(record).reverse(),
    );
    assert.deepEqual(
      await verifyPublicRecord(
        { record: reordered, signature: entry.signatureHex },
        trust,
      ),
      record,
    );
    for (const domain of Object.values(PUBLIC_RECORD_DOMAINS).filter(
      (domain) => domain !== entry.domain,
    )) {
      assert.equal(
        verify(
          null,
          Buffer.from(signingBytes(domain, record)),
          NODE_PUBLIC_KEY,
          Buffer.from(entry.signatureHex, 'hex'),
        ),
        false,
      );
    }
    if (record.kind === PUBLIC_RECORD_KINDS.CATALOG) {
      assert.equal(await catalogDigest(record), vector.catalogDigest);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        vector.catalogDigest,
      );
    }
    await assert.rejects(
      verifyPublicRecord(
        {
          record: { ...record, sequence: record.sequence + 1 },
          signature: entry.signatureHex,
        },
        trust,
      ),
      {
        code: PUBLIC_RECORD_ERROR_CODES.INVALID_SIGNATURE,
      },
    );
  });
}
