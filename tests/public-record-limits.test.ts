// Proves limits and cross-kind rejection paths on synthetic discovery messages.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUBLIC_RECORD_DOMAINS,
  PUBLIC_RECORD_ERROR_CODES,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import {
  parsePublicRecord,
  signPublicRecord,
  verifyPublicRecord,
} from '@gyblos/protocol/public-records';

import {
  PUBLIC_TEST_NOW,
  publicFixture,
  publicLifecycleFixture,
} from './support/public-records.js';

void test('public lifecycle rejects excess lifetimes, catalog expiry and changed catalog identities', async () => {
  const { catalog, presence, withdrawal, signed, linked } =
    await publicLifecycleFixture();
  await assert.rejects(
    verifyPublicRecord(
      signed({ ...presence, expiresAt: presence.issuedAt + 90_001 }),
      linked,
    ),
    { code: PUBLIC_RECORD_ERROR_CODES.INVALID_TIME },
  );
  await assert.rejects(
    verifyPublicRecord(
      signed({ ...withdrawal, expiresAt: withdrawal.issuedAt + 600_001 }),
      linked,
    ),
    { code: PUBLIC_RECORD_ERROR_CODES.INVALID_TIME },
  );
  await assert.rejects(
    verifyPublicRecord(
      signed({ ...withdrawal, expiresAt: catalog.expiresAt + 1 }),
      linked,
    ),
    { code: PUBLIC_RECORD_ERROR_CODES.INVALID_REFERENCE },
  );
  for (const changed of [
    { owner: '11111111111111111111111111111112' },
    { nodeId: publicFixture().catalog.nodeId },
  ])
    await assert.rejects(
      verifyPublicRecord(signed(presence), {
        ...linked,
        catalog: { ...catalog, ...changed },
      }),
      { code: PUBLIC_RECORD_ERROR_CODES.INVALID_REFERENCE },
    );
  for (const record of [presence, withdrawal]) {
    assert.throws(() => parsePublicRecord({ ...record, endpoint: {} }), {
      code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
    });
    assert.throws(
      () => parsePublicRecord({ ...record, catalogDigest: 'AA'.repeat(32) }),
      { code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD },
    );
  }
  assert.throws(() => parsePublicRecord({ ...presence, state: 'online' }), {
    code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
  });
});

void test('public verifier rejects signatures from other domains for every record kind', async () => {
  const { catalog, presence, withdrawal, signed, linked } =
    await publicLifecycleFixture();
  for (const record of [catalog, presence, withdrawal])
    for (const domain of [
      ...Object.values(PUBLIC_RECORD_DOMAINS),
      'gyblos/signed-inference-offer/v1\n',
    ].filter((domain) => domain !== PUBLIC_RECORD_DOMAINS[record.kind]))
      await assert.rejects(verifyPublicRecord(signed(record, domain), linked), {
        code: PUBLIC_RECORD_ERROR_CODES.INVALID_SIGNATURE,
      });
});

void test('public signer detaches data, checks lifetime before calling the signer and preserves signer failures', async () => {
  const { catalog, signer } = publicFixture();
  const failure = new Error('Synthetic signer unavailable.');
  await assert.rejects(
    signPublicRecord(catalog, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  let calls = 0;
  await assert.rejects(
    signPublicRecord(
      { ...catalog, expiresAt: catalog.issuedAt },
      async (bytes) => {
        calls++;
        return signer(bytes);
      },
    ),
    { code: PUBLIC_RECORD_ERROR_CODES.INVALID_TIME },
  );
  assert.equal(calls, 0);
  const pending = signPublicRecord(catalog, async (bytes) => {
    catalog.models[0]!.pricing.inputAtomic = '123';
    return signer(bytes);
  });
  const envelope = await pending;
  assert.equal(envelope.record.kind, PUBLIC_RECORD_KINDS.CATALOG);
  if (envelope.record.kind !== PUBLIC_RECORD_KINDS.CATALOG) return;
  assert.equal(envelope.record.models[0]!.pricing.inputAtomic, '0');
});

void test('public canonical wire size and u64 price bounds reject oversized yet otherwise valid catalogs', () => {
  const { catalog } = publicFixture();
  const model = catalog.models[0]!;
  model.pricing.inputAtomic = PUBLIC_RECORD_LIMITS.maxAtomic;
  assert.deepEqual(parsePublicRecord(catalog), catalog);
  model.pricing.inputAtomic = '18446744073709551616';
  assert.throws(() => parsePublicRecord(catalog), {
    code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
  });
  model.pricing.inputAtomic = '0';
  catalog.models = Array.from(
    { length: PUBLIC_RECORD_LIMITS.maxModels },
    (_, index) => ({
      ...model,
      modelId: String(index).padEnd(128, 'x'),
      variant: 'x'.repeat(128),
      quantization: 'x'.repeat(128),
    }),
  );
  assert.throws(() => parsePublicRecord(catalog), {
    code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
  });
});

void test('public verification snapshots the envelope before asynchronous crypto work', async () => {
  const { catalog, signed, trust } = publicFixture();
  const envelope = signed(catalog);
  const pending = verifyPublicRecord(envelope, {
    ...trust,
    now: PUBLIC_TEST_NOW,
  });
  catalog.sequence = 500;
  catalog.models[0]!.modelId = 'changed';
  envelope.signature = '00'.repeat(64);
  const record = await pending;
  assert.equal(record.sequence, 1);
  assert.equal(record.kind, PUBLIC_RECORD_KINDS.CATALOG);
  if (record.kind === PUBLIC_RECORD_KINDS.CATALOG)
    assert.equal(record.models[0]!.modelId, 'qwen3-0.6b');
});
