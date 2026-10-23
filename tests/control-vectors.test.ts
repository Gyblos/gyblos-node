// Checks v2 contracts against an independent Node/OpenSSL vector; v1 vectors remain untouched.
import assert from 'node:assert/strict';
import { createPublicKey, verify as opensslVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONTROL_DOMAINS,
  CONTROL_LIMITS,
  CONTROL_METHODS,
  CONTROL_VERSION,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';
import { controlRequestDigest } from '@gyblos/protocol/control-requests';
import { parseControlResponse } from '@gyblos/protocol/control-response';
import type { PublicCatalogV2 } from '@gyblos/protocol/control-types';
import { verifyOfferV2 } from '@gyblos/protocol/offer-v2';
import {
  catalogDigestV2,
  parsePublicV2,
  verifyPublicV2,
} from '@gyblos/protocol/public-v2';
import { signingBytes } from '@gyblos/protocol/signing';

interface Vector {
  nodePublicKeyHex: string;
  ownerPublicKeyHex: string;
  records: { record: unknown; signature: string }[];
  catalogDigest: string;
  request: unknown;
  requestDigest: string;
  requestSigningHex: string;
  requestFrameHex: string;
  signedOffer: {
    offer: { owner: string; nodeId: string; issuedAt: number };
    signature: string;
  };
  offerSigningHex: string;
}
void test('control v2 golden bytes, request digest and frame match an independent oracle', async () => {
  const vector: Vector = JSON.parse(
    await readFile(
      new URL(import.meta.resolve('@gyblos/protocol/vectors/control-v2.json')),
      'utf8',
    ),
  );
  assert.equal(
    await controlRequestDigest(vector.request),
    vector.requestDigest,
  );
  assert.equal(
    Buffer.from(signingBytes(CONTROL_DOMAINS.REQUEST, vector.request)).toString(
      'hex',
    ),
    vector.requestSigningHex,
  );
  assert.equal(
    Buffer.from(encodeControlFrame(vector.request)).toString('hex'),
    vector.requestFrameHex,
  );
  const reader = new ControlFrameReader();
  reader.push(Buffer.from(vector.requestFrameHex, 'hex'));
  assert.deepEqual(reader.finish(), vector.request);
});
void test('control v2 public family and owner offer signatures verify with WebCrypto and OpenSSL', async () => {
  const vector: Vector = JSON.parse(
    await readFile(
      new URL(import.meta.resolve('@gyblos/protocol/vectors/control-v2.json')),
      'utf8',
    ),
  );
  const record = parsePublicV2(vector.records[0]!.record);
  assert.equal(record.kind, PUBLIC_RECORD_KINDS.CATALOG);
  const catalog = record as PublicCatalogV2;
  const requestId = '0'.repeat(32);
  const catalogReply = {
    version: CONTROL_VERSION,
    requestId,
    result: { method: CONTROL_METHODS.CATALOG, catalog: vector.records[0] },
  };
  assert.deepEqual(parseControlResponse(catalogReply), catalogReply);
  const offerReply = {
    version: CONTROL_VERSION,
    requestId,
    result: { method: CONTROL_METHODS.OFFER, offer: vector.signedOffer },
  };
  assert.deepEqual(parseControlResponse(offerReply), offerReply);

  assert.equal(await catalogDigestV2(catalog), vector.catalogDigest);
  for (const envelope of vector.records) {
    const parsed = parsePublicV2(envelope.record);
    await verifyPublicV2(envelope, {
      owner: catalog.owner,
      nodeId: catalog.nodeId,
      now: catalog.issuedAt,
      catalog,
    });
    const key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(vector.nodePublicKeyHex, 'hex').toString('base64url'),
      },
      format: 'jwk',
    });
    assert.equal(
      opensslVerify(
        null,
        signingBytes(CONTROL_DOMAINS[parsed.kind], parsed),
        key,
        Buffer.from(envelope.signature, 'hex'),
      ),
      true,
    );
  }
  const offer = await verifyOfferV2(vector.signedOffer, {
    ...vector.signedOffer.offer,
    now: catalog.issuedAt,
  });
  assert.equal(
    Buffer.from(signingBytes(CONTROL_DOMAINS.OFFER, offer)).toString('hex'),
    vector.offerSigningHex,
  );
  const owner = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(vector.ownerPublicKeyHex, 'hex').toString('base64url'),
    },
    format: 'jwk',
  });
  assert.equal(
    opensslVerify(
      null,
      Buffer.from(vector.offerSigningHex, 'hex'),
      owner,
      Buffer.from(vector.signedOffer.signature, 'base64'),
    ),
    true,
  );
  assert.equal(
    Buffer.from(vector.signedOffer.signature, 'base64').length,
    CONTROL_LIMITS.signatureBytes,
  );
});
