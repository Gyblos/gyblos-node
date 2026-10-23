// Creates synthetic, unfunded public records with ephemeral signing material.
// No operational keys, network calls or payment payloads are used.
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  DATA_RETENTION,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_PRICE_UNIT,
  PUBLIC_RECORD_DOMAINS,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import { catalogDigest } from '@gyblos/protocol/public-records';
import type {
  PublicCatalog,
  PublicPresence,
  PublicRecord,
  PublicRecordTrust,
  PublicWithdrawal,
} from '@gyblos/protocol/public-types';
import { signingBytes } from '@gyblos/protocol/signing';

export const PUBLIC_TEST_NOW = 1_800_000_000_000;
export const PUBLIC_TEST_OWNER = '11111111111111111111111111111111';

export function publicFixture() {
  const keys = generateKeyPairSync('ed25519');
  const nodeId = keys.publicKey.export({ format: 'jwk' }).x;
  if (!nodeId) throw new Error('Missing synthetic public key.');
  const catalog: PublicCatalog = {
    schemaVersion: PUBLIC_RECORD_LIMITS.schemaVersion,
    kind: PUBLIC_RECORD_KINDS.CATALOG,
    owner: PUBLIC_TEST_OWNER,
    nodeId: Buffer.from(nodeId, 'base64url').toString('hex'),
    sequence: 1,
    issuedAt: PUBLIC_TEST_NOW,
    expiresAt: PUBLIC_TEST_NOW + 600_000,
    models: [
      {
        modelId: 'qwen3-0.6b',
        variant: null,
        quantization: 'Q4_K_M',
        contextTokens: 2048,
        pricing: {
          network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
          asset: PUBLIC_TEST_OWNER,
          unit: PUBLIC_PRICE_UNIT,
          inputAtomic: '0',
          outputAtomic: '2',
        },
      },
    ],
    dataPolicy: { retention: DATA_RETENTION.NONE },
  };
  const trust: PublicRecordTrust = {
    owner: catalog.owner,
    nodeId: catalog.nodeId,
    now: PUBLIC_TEST_NOW,
  };
  const signer = async (bytes: Uint8Array<ArrayBuffer>) =>
    Uint8Array.from(sign(null, bytes, keys.privateKey));
  function signed(
    record: PublicRecord,
    domain: string = PUBLIC_RECORD_DOMAINS[record.kind],
  ) {
    return {
      record,
      signature: sign(
        null,
        signingBytes(domain, record),
        keys.privateKey,
      ).toString('hex'),
    };
  }
  return { catalog, trust, signer, signed };
}

export async function publicLifecycleFixture() {
  const fixture = publicFixture();
  const { catalog } = fixture;
  const {
    models: _models,
    dataPolicy: _policy,
    kind: _kind,
    ...header
  } = catalog;
  const digest = await catalogDigest(catalog);
  const presence: PublicPresence = {
    ...header,
    kind: PUBLIC_RECORD_KINDS.PRESENCE,
    sequence: 2,
    issuedAt: PUBLIC_TEST_NOW + 1,
    expiresAt: PUBLIC_TEST_NOW + 90_000,
    catalogDigest: digest,
    state: PUBLIC_PRESENCE_STATE,
  };
  const withdrawal: PublicWithdrawal = {
    ...header,
    kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
    sequence: 3,
    issuedAt: PUBLIC_TEST_NOW + 1,
    expiresAt: PUBLIC_TEST_NOW + 90_000,
    catalogDigest: digest,
  };
  return {
    ...fixture,
    presence,
    withdrawal,
    linked: { ...fixture.trust, now: PUBLIC_TEST_NOW + 2, catalog },
  };
}
