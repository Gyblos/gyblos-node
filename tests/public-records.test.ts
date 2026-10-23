// Exercises strict public JSON, node-key signatures, freshness and catalog links.
// Everything is synthetic and offline; the paid offer remains a separate contract.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUBLIC_RECORD_DOMAINS,
  PUBLIC_RECORD_ERROR_CODES,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import {
  catalogDigest,
  parsePublicRecord,
  signPublicRecord,
  verifyPublicRecord,
} from '@gyblos/protocol/public-records';
import { signingBytes } from '@gyblos/protocol/signing';

import {
  PUBLIC_TEST_NOW,
  publicFixture,
  publicLifecycleFixture,
} from './support/public-records.js';

void test('public catalog signing round-trips with a node key and a caller-trusted owner binding', async () => {
  const { catalog, signer, signed, trust } = publicFixture();
  const envelope = await signPublicRecord(catalog, signer);
  assert.deepEqual(envelope, signed(catalog));
  assert.deepEqual(await verifyPublicRecord(envelope, trust), catalog);
  assert.deepEqual(parsePublicRecord(catalog), catalog);
});

void test('public catalog rejects unknown fields at every object boundary, including private offer data', () => {
  const { catalog } = publicFixture();
  const model = catalog.models[0]!;
  for (const value of [
    { ...catalog, buyer: 'private' },
    { ...catalog, endpoint: { directAddresses: ['redacted'] } },
    { ...catalog, engineUrl: 'private' },
    { ...catalog, dataPolicy: { ...catalog.dataPolicy, prompt: 'synthetic' } },
    { ...catalog, models: [{ ...model, engine: 'private' }] },
    {
      ...catalog,
      models: [{ ...model, pricing: { ...model.pricing, token: 'private' } }],
    },
  ])
    assert.throws(() => parsePublicRecord(value), {
      code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
    });
});

void test('public parsing rejects malformed shapes, identities, versions and discriminants', () => {
  const { catalog } = publicFixture();
  for (const value of [
    null,
    [],
    1,
    {},
    { ...catalog, schemaVersion: 2 },
    { ...catalog, kind: 'offer' },
    { ...catalog, owner: '0'.repeat(32) },
    { ...catalog, owner: 'z'.repeat(44) },
    { ...catalog, nodeId: 'a'.repeat(63) },
    { ...catalog, nodeId: 'A'.repeat(64) },
    { ...catalog, sequence: 0 },
    { ...catalog, sequence: 1.1 },
    { ...catalog, issuedAt: -1 },
    { ...catalog, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...catalog, dataPolicy: { retention: 'guaranteed-private' } },
  ])
    assert.throws(() => parsePublicRecord(value), {
      code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
    });
});

void test('public model listings bound amounts, counts, identifiers, variants and pricing units', () => {
  const { catalog } = publicFixture();
  const model = catalog.models[0]!;
  const malformed = [
    { ...model, modelId: 'https://private.example/path' },
    { ...model, variant: '' },
    { ...model, quantization: false },
    { ...model, contextTokens: 0 },
    { ...model, contextTokens: 1.1 },
    { ...model, contextTokens: PUBLIC_RECORD_LIMITS.maxContextTokens + 1 },
    ...['01', '-1', '1.0', '1e6', '1'.repeat(21), 2].map((inputAtomic) => ({
      ...model,
      pricing: { ...model.pricing, inputAtomic },
    })),
    { ...model, pricing: { ...model.pricing, unit: 'million-tokens' } },
    { ...model, pricing: { ...model.pricing, network: 'mainnet' } },
    {
      ...model,
      pricing: { ...model.pricing, network: 'solana:' + 'a'.repeat(33) },
    },
    { ...model, pricing: { ...model.pricing, asset: 'not-a-mint' } },
  ];
  for (const value of malformed)
    assert.throws(() => parsePublicRecord({ ...catalog, models: [value] }), {
      code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
    });
  for (const models of [
    [],
    Array.from({ length: PUBLIC_RECORD_LIMITS.maxModels + 1 }, (_, index) => ({
      ...model,
      modelId: `custom-${index}`,
    })),
    [model, model],
  ])
    assert.throws(() => parsePublicRecord({ ...catalog, models }), {
      code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
    });
});

void test('public catalogs allow free/custom models and distinct variants without asserting verification', () => {
  const { catalog } = publicFixture();
  const model = catalog.models[0]!;
  model.modelId = 'Qwen/Qwen3-0.6B';
  model.pricing.outputAtomic = '0';
  catalog.models.push({ ...model, quantization: 'Q8_0' });
  assert.deepEqual(parsePublicRecord(catalog), catalog);
});

void test('public parsing rejects accessors, prototypes and sparse arrays without evaluating them', () => {
  const { catalog } = publicFixture();
  let accessed = false;
  const getter = { ...catalog };
  Object.defineProperty(getter, 'owner', {
    enumerable: true,
    get() {
      accessed = true;
      return catalog.owner;
    },
  });
  const inherited: unknown = Object.create(catalog);
  const ownWithPrototype: unknown = Object.assign(
    Object.create({ inherited: true }),
    catalog,
  );
  const customArray = [...catalog.models];
  Object.setPrototypeOf(customArray, Object.create(Array.prototype));
  const sparse = new Array(1);
  const symbol = { ...catalog, [Symbol('private')]: 'synthetic' };
  for (const value of [
    getter,
    inherited,
    ownWithPrototype,
    { ...catalog, models: customArray },
    { ...catalog, models: sparse },
    symbol,
  ])
    assert.throws(() => parsePublicRecord(value), {
      code: PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
    });
  assert.equal(accessed, false);
});

void test('public verification rejects untrusted owner or NodeId before returning a record', async () => {
  const { catalog, signed, trust } = publicFixture();
  for (const changed of [
    { owner: publicFixture().catalog.owner + '1' },
    { nodeId: '00'.repeat(32) },
  ])
    await assert.rejects(
      verifyPublicRecord(signed(catalog), { ...trust, ...changed }),
      { code: PUBLIC_RECORD_ERROR_CODES.UNTRUSTED_IDENTITY },
    );
});

void test('public signatures reject validly shaped tampering, wrong domains and malformed encodings', async () => {
  const { catalog, signed, trust } = publicFixture();
  const envelope = signed(catalog);
  for (const value of [
    { ...envelope, record: { ...catalog, sequence: 2 } },
    { ...envelope, signature: '00'.repeat(64) },
    { ...envelope, signature: envelope.signature.toUpperCase() },
    { ...envelope, signature: 'ab'.repeat(63) },
    { ...envelope, signature: 'not-hex' },
  ])
    await assert.rejects(verifyPublicRecord(value, trust), {
      code: PUBLIC_RECORD_ERROR_CODES.INVALID_SIGNATURE,
    });
  const wrongSigner = async (bytes: Uint8Array<ArrayBuffer>) => {
    assert.deepEqual(
      bytes,
      signingBytes(PUBLIC_RECORD_DOMAINS.catalog, catalog),
    );
    return new Uint8Array(63);
  };
  await assert.rejects(signPublicRecord(catalog, wrongSigner), {
    code: PUBLIC_RECORD_ERROR_CODES.INVALID_SIGNATURE,
  });
});

void test('public envelope rejects private or unsupported fields without echoing supplied input', async () => {
  const { catalog, signed, trust } = publicFixture();
  await assert.rejects(
    verifyPublicRecord(
      { ...signed(catalog), token: 'SYNTHETIC_SECRET' },
      trust,
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        Reflect.get(error, 'code'),
        PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD,
      );
      assert.ok(!JSON.stringify(error).includes('SYNTHETIC_SECRET'));
      assert.ok(!error.stack?.includes('SYNTHETIC_SECRET'));
      return true;
    },
  );
});

void test('public freshness rejects future, expired, inverted and excessive catalog lifetimes', async () => {
  const { catalog, signed, trust } = publicFixture();
  for (const times of [
    { issuedAt: PUBLIC_TEST_NOW + 1 },
    { issuedAt: PUBLIC_TEST_NOW - 1, expiresAt: PUBLIC_TEST_NOW },
    { expiresAt: catalog.expiresAt + 1 },
    { expiresAt: catalog.issuedAt - 1 },
  ])
    await assert.rejects(
      verifyPublicRecord(signed({ ...catalog, ...times }), trust),
      { code: PUBLIC_RECORD_ERROR_CODES.INVALID_TIME },
    );
  await assert.rejects(
    verifyPublicRecord(signed(catalog), { ...trust, now: NaN }),
    { code: PUBLIC_RECORD_ERROR_CODES.INVALID_TIME },
  );
});

void test('public sequence rejects duplicates and rollback but permits a strictly newer record', async () => {
  const { catalog, signed, trust } = publicFixture();
  for (const lastSequence of [1, 2, -1, NaN])
    await assert.rejects(
      verifyPublicRecord(signed(catalog), { ...trust, lastSequence }),
      { code: PUBLIC_RECORD_ERROR_CODES.STALE_SEQUENCE },
    );
  assert.deepEqual(
    await verifyPublicRecord(signed(catalog), { ...trust, lastSequence: 0 }),
    catalog,
  );
});

void test('public presence and withdrawal authenticate the exact catalog and ordered node lifecycle', async () => {
  const { catalog, presence, withdrawal, signed, linked } =
    await publicLifecycleFixture();
  assert.match(await catalogDigest(catalog), /^[0-9a-f]{64}$/);
  assert.deepEqual(
    await verifyPublicRecord(signed(presence), linked),
    presence,
  );
  assert.deepEqual(
    await verifyPublicRecord(signed(withdrawal), {
      ...linked,
      lastSequence: 2,
    }),
    withdrawal,
  );
  for (const record of [presence, withdrawal]) {
    for (const value of [
      { ...record, catalogDigest: '00'.repeat(32) },
      { ...record, sequence: 1 },
      {
        ...record,
        issuedAt: PUBLIC_TEST_NOW - 1,
        expiresAt: PUBLIC_TEST_NOW + 89_999,
      },
    ])
      await assert.rejects(verifyPublicRecord(signed(value), linked), {
        code: PUBLIC_RECORD_ERROR_CODES.INVALID_REFERENCE,
      });
    await assert.rejects(
      verifyPublicRecord(signed(record), { ...linked, catalog: undefined }),
      { code: PUBLIC_RECORD_ERROR_CODES.INVALID_REFERENCE },
    );
    await assert.rejects(
      verifyPublicRecord(signed(record), { ...linked, lastSequence: 3 }),
      { code: PUBLIC_RECORD_ERROR_CODES.STALE_SEQUENCE },
    );
  }
});
