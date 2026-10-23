// Protects additive public v2 signatures, reasoning declarations and cross-version references.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  CONTROL_DOMAINS,
  CONTROL_RECORD_VERSION,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_RECORD_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type {
  PublicPresenceV2,
  PublicWithdrawalV2,
} from '@gyblos/protocol/control-types';
import {
  parsePublicRecord,
  verifyPublicRecord,
} from '@gyblos/protocol/public-records';
import {
  catalogDigestV2,
  parsePublicV2,
  publicV2CacheKey,
  signPublicV2,
  verifyPublicV2,
} from '@gyblos/protocol/public-v2';
import { signingBytes } from '@gyblos/protocol/signing';

import { controlFixture } from './support/control-fixture.js';
import { publicFixture } from './support/public-records.js';

void test('public v2 round-trips catalog, presence and withdrawal with node signatures', async () => {
  const fixture = await controlFixture();
  const trust = fixture.trust();
  assert.deepEqual(
    await verifyPublicV2(fixture.context.catalog, {
      ...trust,
      catalog: fixture.catalog,
    }),
    fixture.catalog,
  );
  const { models: _models, dataPolicy: _policy, ...header } = fixture.catalog;
  const presence: PublicPresenceV2 = {
    ...header,
    kind: PUBLIC_RECORD_KINDS.PRESENCE,
    sequence: 2,
    expiresAt: header.issuedAt + 90000,
    catalogDigest: await catalogDigestV2(fixture.catalog),
    state: PUBLIC_PRESENCE_STATE,
  };
  const withdrawal: PublicWithdrawalV2 = {
    ...header,
    kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
    sequence: 3,
    catalogDigest: presence.catalogDigest,
  };
  for (const record of [presence, withdrawal])
    assert.deepEqual(
      await verifyPublicV2(await signPublicV2(record, fixture.nodeSigner), {
        ...trust,
        catalog: fixture.catalog,
      }),
      record,
    );
  await assert.rejects(
    verifyPublicV2(await signPublicV2(presence, fixture.nodeSigner), {
      ...trust,
      catalog: fixture.catalog,
      lastSequence: 2,
    }),
    { code: CONTROL_CODES.STALE },
  );
  assert.equal(
    publicV2CacheKey(trust.owner, trust.nodeId).startsWith('2:'),
    true,
  );
});
void test('public v2 rejects legacy shapes, cross-domain signatures and cross-version catalog links', async () => {
  const legacy = publicFixture();
  const fixture = await controlFixture();
  assert.throws(() => parsePublicV2(legacy.catalog), {
    code: CONTROL_CODES.VERSION,
  });
  assert.throws(() => parsePublicRecord(fixture.catalog));
  await assert.rejects(
    verifyPublicRecord(fixture.context.catalog, {
      owner: fixture.catalog.owner,
      nodeId: fixture.catalog.nodeId,
      now: fixture.context.now(),
    }),
  );
  const signature = await fixture.nodeSigner(
    signingBytes('gyblos/catalog/v1\n', fixture.catalog),
  );
  await assert.rejects(
    verifyPublicV2(
      {
        record: fixture.catalog,
        signature: Buffer.from(signature).toString('hex'),
      },
      { ...fixture.trust(), catalog: fixture.catalog },
    ),
    { code: CONTROL_CODES.SIGNATURE },
  );
  const { models: _models, dataPolicy: _policy, ...header } = fixture.catalog;
  const presence: PublicPresenceV2 = {
    ...header,
    kind: PUBLIC_RECORD_KINDS.PRESENCE,
    sequence: 2,
    expiresAt: header.issuedAt + 90000,
    catalogDigest: await catalogDigestV2(fixture.catalog),
    state: PUBLIC_PRESENCE_STATE,
  };
  const value: unknown = { ...fixture.catalog, schemaVersion: 1 };
  await assert.rejects(
    verifyPublicV2(await signPublicV2(presence, fixture.nodeSigner), {
      ...fixture.trust(),
      catalog: value as typeof fixture.catalog,
    }),
    { code: CONTROL_CODES.VERSION },
  );
});
void test('public v2 rejects duplicate models, invalid reasoning and private or unknown fields', async () => {
  const fixture = await controlFixture();
  const model = fixture.catalog.models[0]!;
  for (const catalog of [
    { ...fixture.catalog, models: [model, model] },
    { ...fixture.catalog, models: [{ ...model, reasoning: [] }] },
    {
      ...fixture.catalog,
      models: [
        { ...model, reasoning: [REASONING_LEVELS.OFF, REASONING_LEVELS.OFF] },
      ],
    },
    { ...fixture.catalog, models: [{ ...model, reasoning: ['unsupported'] }] },
    { ...fixture.catalog, models: [{ ...model, engineUrl: 'PRIVATE' }] },
    { ...fixture.catalog, endpoint: 'PRIVATE' },
  ])
    assert.throws(() => parsePublicV2(catalog), {
      code: CONTROL_CODES.INVALID,
    });
  assert.equal(fixture.catalog.schemaVersion, CONTROL_RECORD_VERSION);
  assert.equal(CONTROL_DOMAINS.catalog.endsWith('\n'), true);
});
