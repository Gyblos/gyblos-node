import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import test from 'node:test';

import { NODE_ENVIRONMENT } from '@gyblos/config';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { publishSellerRecord } from '@gyblos/node/publisher';
import { SELLER_VERSION } from '@gyblos/protocol/constants';
import { sellerVersionProof } from '@gyblos/protocol/seller-version';

import { createSqliteD1 } from './support/d1-sqlite';
import {
  eachStorage,
  indexHarness,
  indexNode,
} from './support/discovery-index-fixture';

eachStorage(
  'an active legacy seller has an unknown release',
  async ({ publish, call }) => {
    const node = indexNode();
    const catalog = node.catalog(1);
    assert.equal((await publish(catalog)).status, 201);
    assert.equal((await publish(await node.presence(2, catalog))).status, 201);
    const response = await call('/v1/versions?node=' + node.nodeId);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      nodeId: node.nodeId,
      version: null,
    });
  },
);

eachStorage(
  'the release accompanies unchanged signed presence and counts active identities once',
  async ({ call, publish, clock }) => {
    const seller = indexNode();
    const other = indexNode();
    const catalog = seller.catalog(1);
    const legacy = other.catalog(1);
    await publish(catalog);
    await publish(legacy);
    await publish(await other.presence(2, legacy));
    for (const [sequence, version] of [
      [2, '0.1.0-beta.12'],
      [3, '0.1.0-beta.13'],
    ] as const) {
      const record = await seller.presence(sequence, catalog);
      await publishSellerRecord(
        {
          baseUrl: 'https://index.example/v1',
          record,
          fetch: async (url, init) => {
            assert.equal(init.body, JSON.stringify({ record }));
            const header = new Headers(init.headers).get(SELLER_VERSION.header);
            assert.ok(header);
            const [release, signature] = header.split(':');
            assert.equal(release, version);
            assert.ok(signature);
            const publicKey = createPublicKey({
              format: 'jwk',
              key: {
                kty: 'OKP',
                crv: 'Ed25519',
                x: Buffer.from(seller.nodeId, 'hex').toString('base64url'),
              },
            });
            assert.ok(
              verify(
                null,
                Buffer.from(
                  'gyblos/seller-version/v1\n' +
                    JSON.stringify({
                      presenceSignature: record.signature,
                      version,
                    }),
                ),
                publicKey,
                Buffer.from(signature, 'hex'),
              ),
            );

            return call(new URL(url).pathname, init);
          },
        },
        { [NODE_ENVIRONMENT.version]: version },
        seller.signer,
      );
      assert.deepEqual(
        await (await call('/v1/versions?node=' + seller.nodeId)).json(),
        { nodeId: seller.nodeId, version },
      );
      assert.deepEqual(await (await call('/v1/versions')).json(), {
        active: 2,
        unknown: 1,
        versions: [{ version, nodes: 1 }],
        truncated: false,
      });
    }
    await publish(await other.withdrawal(3, legacy));
    assert.equal((await call('/v1/versions?node=' + other.nodeId)).status, 404);
    clock.now += 90000;
    assert.deepEqual(await (await call('/v1/versions')).json(), {
      active: 0,
      unknown: 0,
      versions: [],
      truncated: false,
    });
  },
);
eachStorage(
  'a different key or heartbeat cannot declare a seller release',
  async ({ publish, call }) => {
    const seller = indexNode();
    const other = indexNode();
    const catalog = seller.catalog(1);
    await publish(catalog);
    const prior = await seller.presence(2, catalog);
    const version = '0.1.0-beta.13';
    assert.equal(
      await sellerVersionProof(catalog, version, seller.signer),
      undefined,
    );
    assert.equal(
      await sellerVersionProof(prior, 'source', seller.signer),
      undefined,
    );
    assert.equal(
      await sellerVersionProof(prior, '0.1.0-beta.01', seller.signer),
      undefined,
    );
    const replay = await sellerVersionProof(prior, version, seller.signer);
    assert.ok(replay);
    const next = await seller.presence(3, catalog);
    const forged = await sellerVersionProof(next, version, other.signer);
    assert.ok(forged);
    for (const [record, proof] of [
      [next, forged],
      [await seller.presence(4, catalog), replay],
      [await seller.presence(5, catalog), 'invalid'],
    ] as const) {
      assert.equal(
        (await publish(record, { headers: { [SELLER_VERSION.header]: proof } }))
          .status,
        201,
      );
      assert.deepEqual(
        await (await call('/v1/versions?node=' + seller.nodeId)).json(),
        { nodeId: seller.nodeId, version: null },
      );
    }
    assert.equal((await call('/v1/versions?node=other')).status, 400);
  },
);

void test('a rolling upgrade never attributes an earlier release to a heartbeat written by an old index', async (context) => {
  const database = await createSqliteD1();
  if (!database) return context.skip('node:sqlite unavailable');
  context.after(() => database.raw.close());
  const harness = await indexHarness('memory', {
    storage: createD1Storage(database),
  });
  assert.ok(harness);
  const seller = indexNode();
  const catalog = seller.catalog(1);
  await harness.publish(catalog);
  const presence = await seller.presence(2, catalog);
  const version = '0.1.0-beta.13';
  const proof = await sellerVersionProof(presence, version, seller.signer);
  assert.ok(proof);
  await harness.publish(presence, {
    headers: { [SELLER_VERSION.header]: proof },
  });
  const path = '/v1/versions?node=' + seller.nodeId;
  assert.deepEqual(await (await harness.call(path)).json(), {
    nodeId: seller.nodeId,
    version,
  });
  const next = await seller.presence(3, catalog);
  database.raw
    .prepare(
      'UPDATE discovery_presence SET sequence=?,signed_json=? WHERE node_id=?',
    )
    .run(next.record.sequence, JSON.stringify(next), seller.nodeId);
  assert.deepEqual(await (await harness.call(path)).json(), {
    nodeId: seller.nodeId,
    version: null,
  });
});

void test('an unavailable release signer preserves the already signed presence', async () => {
  const seller = indexNode();
  const record = await seller.presence(2, seller.catalog(1));
  await publishSellerRecord(
    {
      record,
      baseUrl: 'https://index.example/v1',
      fetch: async (_url, init) => {
        assert.equal(
          new Headers(init.headers).has(SELLER_VERSION.header),
          false,
        );
        assert.equal(init.body, JSON.stringify({ record }));
        return Response.json({ ok: true }, { status: 201 });
      },
    },
    { [NODE_ENVIRONMENT.version]: '0.1.0-beta.13' },
    async () => {
      throw new Error('unavailable');
    },
  );
});
